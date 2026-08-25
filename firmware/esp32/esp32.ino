#include <WiFi.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>

#define ONE_WIRE_BUS 13 // NOT GPIO12 -- that's a boot-strapping pin (controls flash voltage) and
                        // the DS18B20's required pull-up resistor would hold it HIGH at reset,
                        // which can prevent the board from booting at all.
#define TURBIDITY_PIN 34 // ADC1_CH6, input-only -- keep sensors off ADC2 pins (Wi-Fi disables ADC2)
#define TDS_PIN 35 // ADC1_CH7, input-only. TDS Meter V1.0 outputs 0-2.3V max, so it wires
                   // directly into this pin -- no divider needed, unlike the turbidity sensor.
#define FLOW_PIN 27 // Digital pulse input (hall-effect flow sensor, e.g. YF-S201) -- not an
                    // ADC pin, so the ADC1-only-with-WiFi constraint above doesn't apply here.
                    // Free of the other sensors' pins (13/34/35) and not a boot-strapping pin.

// Sensor's analog OUT is scaled down by a 10k/20k divider (ratio 2/3) before reaching
// GPIO34, since the sensor outputs up to ~4.5V but ESP32 ADC pins are only 3.3V safe.
// This undoes the divider to recover the sensor's real 0-4.5V output for the NTU formula.
const float dividerRecoveryFactor = 1.5; // (R1 + R2) / R2 = 30k / 20k
const float adcVref = 5.0;

// Factory-default WiFi -- only ever used on a completely fresh board, before it has been
// provisioned once via USB (see the WIFI_SCAN/WIFI_SET serial protocol below). Once a
// WIFI_SET succeeds, the real credentials live in NVS flash (Preferences, namespace "wifi")
// and these consts are never consulted again.
const char* defaultSsid = "W7";
const char* defaultPassword = "Asdfghjkl";
const int backendPort = 8080;

// Currently-active WiFi credentials, loaded from NVS at boot (falling back to the defaults
// above) and updated in-memory whenever a WIFI_SET succeeds -- kept separately from NVS so a
// failed WIFI_SET can immediately retry these without a flash read.
Preferences wifiPrefs;
String currentSsid;
String currentPassword;

void loadWifiCredentials() {
  wifiPrefs.begin("wifi", true); // read-only
  currentSsid = wifiPrefs.getString("ssid", defaultSsid);
  currentPassword = wifiPrefs.getString("pass", defaultPassword);
  wifiPrefs.end();
}

void saveWifiCredentials(const String& newSsid, const String& newPassword) {
  wifiPrefs.begin("wifi", false); // read-write
  wifiPrefs.putString("ssid", newSsid);
  wifiPrefs.putString("pass", newPassword);
  wifiPrefs.end();
  currentSsid = newSsid;
  currentPassword = newPassword;
}

// IFTTT Maker Webhooks fallback: used only when the backend PC (main.py) can't be reached but
// Wi-Fi/internet still work, so a reading isn't silently dropped during a backend outage.
// Fill in iftttWebhookKey with your own key from https://ifttt.com/maker_webhooks (the
// "Documentation" link on that page shows your personal key). iftttEventName must match the
// event name configured in the IFTTT applet's Webhooks "Receive a web request" trigger.
const char* iftttEventName = "hydro_reading";
const char* iftttWebhookKey = "YOUR_IFTTT_WEBHOOKS_KEY"; // <-- fill in your own key
const String iftttWebhookUrl = "https://maker.ifttt.com/trigger/" + String(iftttEventName) + "/with/key/" + String(iftttWebhookKey);

// Backend IP is normally found at runtime via UDP broadcast discovery (see discoverBackend())
// instead of being hardcoded, so the sketch keeps working after the backend PC's
// DHCP-assigned IP changes. main.py must be running its discovery listener on this port.
// UDP broadcast never crosses networks though -- it only ever finds a backend sharing the
// board's own subnet. When the board's WiFi network and the backend PC's network differ (see
// BACKEND_SET below), a fixed host/IP set via USB overrides discovery entirely.
const unsigned int discoveryPort = 8888;
const char* discoveryRequest = "HYDRO_DISCOVER";
const char* discoveryReply = "HYDRO_HERE";
WiFiUDP discoveryUdp;

// Fixed backend host override, persisted in NVS (separate namespace from WiFi credentials so
// clearing one never disturbs the other) and settable over USB the same way as WIFI_SET --
// see the "USB WiFi provisioning" section below for why USB is the provisioning channel.
// Empty string (the default) means "keep using same-LAN auto-discovery"; any other value is
// used verbatim as the backend's hostname/IP, skipping discoverBackend() entirely.
//
// apiKey/useHttps travel with it because they only matter together: a fixed host usually means
// the backend is reachable from beyond the LAN (see BACKEND_SET below), at which point sending
// the shared secret main.py checks (UPDATE_API_KEY in main.py) in cleartext over plain HTTP
// would defeat the point of having one -- so useHttps switches the POST to main.py's HTTPS
// listener (httpsPort in webconfig.json, default 8443) instead of the plain :8080 one.
Preferences backendPrefs;
String currentBackendHost;
String currentApiKey;
bool currentUseHttps = false;
const int httpsBackendPort = 8443; // must match webconfig.json's httpsPort on the backend

void loadBackendHost() {
  backendPrefs.begin("backend", true); // read-only
  currentBackendHost = backendPrefs.getString("host", "");
  currentApiKey = backendPrefs.getString("apikey", "");
  currentUseHttps = backendPrefs.getBool("https", false);
  backendPrefs.end();
}

void saveBackendHost(const String& host, const String& apiKey, bool useHttps) {
  backendPrefs.begin("backend", false); // read-write
  backendPrefs.putString("host", host);
  backendPrefs.putString("apikey", apiKey);
  backendPrefs.putBool("https", useHttps);
  backendPrefs.end();
  currentBackendHost = host;
  currentApiKey = apiKey;
  currentUseHttps = useHttps;
}

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);
String backendUrl;
bool backendKnown = false;
int consecutiveFailures = 0;
const int maxFailuresBeforeRediscover = 3;

unsigned long lastBroadcastTime = 0;
const unsigned long broadcastInterval = 2000;

unsigned long lastIftttPostTime = 0;
const unsigned long iftttPostInterval = 60000; // 60s, independent of broadcastInterval -- respects IFTTT free-tier rate limits

// Flow sensor: pulse-counted via interrupt (unlike the other sensors' synchronous
// analogRead) since pulses can arrive at any time between broadcastInterval ticks, not just
// when polled. volatile + a critical section (not just noInterrupts/interrupts, which only
// guard against other ISRs on classic AVR, not ESP32's dual-core setup) because the ISR runs
// asynchronously to loop(). Pulses-to-liters conversion (the k-factor) is backend-owned, same
// reasoning as turbidity/TDS -- this board only ever reports a raw count.
volatile unsigned long flowPulseCount = 0;
portMUX_TYPE flowMux = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR onFlowPulse() {
  portENTER_CRITICAL_ISR(&flowMux);
  flowPulseCount++;
  portEXIT_CRITICAL_ISR(&flowMux);
}

// --- USB WiFi provisioning -----------------------------------------------------
// Lets the dashboard's Calibration > WiFi tab (backed by main.py's wifi_serial.py module,
// talking to whichever COM/USB-serial port this board enumerates as) scan for networks and
// set new credentials over the USB cable -- the only channel available before the board has
// working WiFi. Every machine-readable line is prefixed "WIFI_" so it can't be confused with
// the free-form Serial.println debug output used throughout the rest of this sketch. Line
// bytes are accumulated non-blockingly in loop() (see readSerialCommands below), not here --
// WiFi.scanNetworks()/WiFi.begin() themselves DO block for a few seconds once a full command
// line is seen, which is fine since these are explicit user-triggered actions, not part of
// the normal 2s sensor cadence.

String serialLineBuffer;

void handleWifiScan() {
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    bool secured = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    Serial.printf("WIFI_NET|%s|%d|%d\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i), secured ? 1 : 0);
  }
  WiFi.scanDelete();
  Serial.println("WIFI_SCAN_DONE");
}

void handleWifiSet(const String& newSsid, const String& newPassword) {
  WiFi.disconnect();
  WiFi.begin(newSsid.c_str(), newPassword.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(200);
  }

  if (WiFi.status() == WL_CONNECTED) {
    // Only persist on confirmed success -- a bad password never overwrites a working
    // previously-saved network (see saveWifiCredentials's header comment).
    saveWifiCredentials(newSsid, newPassword);
    backendKnown = false; // force UDP rediscovery -- the backend's IP may differ on this network
    Serial.printf("WIFI_CONNECTED|%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("WIFI_FAILED|timeout");
    // Fall back to whatever was working before, so a typo'd password doesn't leave the
    // board stranded offline until the next USB session.
    WiFi.disconnect();
    WiFi.begin(currentSsid.c_str(), currentPassword.c_str());
  }
}

void handleWifiStatus() {
  bool connected = WiFi.status() == WL_CONNECTED;
  Serial.printf(
    "WIFI_STATUS|%d|%s|%s|%d\n",
    connected ? 1 : 0,
    connected ? WiFi.SSID().c_str() : currentSsid.c_str(),
    connected ? WiFi.localIP().toString().c_str() : "",
    connected ? WiFi.RSSI() : 0
  );
}

// Applies currentBackendHost/currentUseHttps immediately: fixed host -> build backendUrl from
// it (https:// + httpsBackendPort, or http:// + backendPort) and mark known (no discovery
// needed); cleared back to "" -> force rediscovery on the LAN, since the previously-fixed host
// is no longer authoritative and the real one might be different.
void applyBackendHost() {
  if (currentBackendHost.length() > 0) {
    if (currentUseHttps) {
      backendUrl = String("https://") + currentBackendHost + ":" + httpsBackendPort + "/update";
    } else {
      backendUrl = String("http://") + currentBackendHost + ":" + backendPort + "/update";
    }
    backendKnown = true;
    Serial.print("Using configured backend: ");
    Serial.println(backendUrl);
  } else {
    backendKnown = false;
  }
}

// line looks like "BACKEND_SET|<host>|<apiKey>|<https:0|1>". apiKey/https default to
// empty/off if the caller only sends the older 2-field host-only form, so a stale UI build
// doesn't break -- but every current WifiPanel.tsx submission includes all three.
void handleBackendSet(const String& args) {
  int sep1 = args.indexOf('|');
  String host = sep1 == -1 ? args : args.substring(0, sep1);
  String apiKey = "";
  bool useHttps = false;
  if (sep1 != -1) {
    int sep2 = args.indexOf('|', sep1 + 1);
    if (sep2 == -1) {
      apiKey = args.substring(sep1 + 1);
    } else {
      apiKey = args.substring(sep1 + 1, sep2);
      useHttps = args.substring(sep2 + 1) == "1";
    }
  }
  saveBackendHost(host, apiKey, useHttps);
  applyBackendHost();
  Serial.printf("BACKEND_SET_OK|%s\n", host.c_str());
}

void handleBackendClear() {
  saveBackendHost("", "", false);
  applyBackendHost();
  Serial.println("BACKEND_SET_OK|");
}

void handleBackendStatus() {
  // fixed=1 when a host override is active (currentBackendHost non-empty); backendUrl is
  // whatever's currently in effect either way (fixed host, or the last-discovered LAN one).
  // The API key itself is never echoed back over serial, same as WIFI_STATUS never echoing
  // the WiFi password -- only whether one is set (hasKey).
  Serial.printf(
    "BACKEND_STATUS|%d|%s|%s|%d|%d\n",
    currentBackendHost.length() > 0 ? 1 : 0,
    currentBackendHost.c_str(),
    backendUrl.c_str(),
    currentApiKey.length() > 0 ? 1 : 0,
    currentUseHttps ? 1 : 0
  );
}

void handleSerialLine(String line) {
  line.trim();
  if (line == "WIFI_SCAN") {
    handleWifiScan();
  } else if (line == "WIFI_STATUS") {
    handleWifiStatus();
  } else if (line.startsWith("WIFI_SET|")) {
    int firstSep = line.indexOf('|', 9);
    if (firstSep == -1) {
      Serial.println("WIFI_FAILED|malformed_command");
      return;
    }
    String newSsid = line.substring(9, firstSep);
    String newPassword = line.substring(firstSep + 1);
    handleWifiSet(newSsid, newPassword);
  } else if (line.startsWith("BACKEND_SET|")) {
    handleBackendSet(line.substring(12));
  } else if (line == "BACKEND_CLEAR") {
    handleBackendClear();
  } else if (line == "BACKEND_STATUS") {
    handleBackendStatus();
  }
  // Unrecognized lines are silently ignored -- could be stray input from a human typing in
  // the Serial Monitor rather than the backend's parser.
}

// Non-blocking: called every loop() iteration (not gated by broadcastInterval) so typing a
// command feels responsive even while the sensor-read/POST cycle is mid-flight.
void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      handleSerialLine(serialLineBuffer);
      serialLineBuffer = "";
    } else if (c != '\r') {
      serialLineBuffer += c;
    }
  }
}

// Broadcasts a discovery request and waits for the backend to reply. On success,
// sets backendUrl from the reply's source IP. Returns false (and leaves backendUrl
// untouched) if nothing answers within timeoutMs.
bool discoverBackend(unsigned long timeoutMs = 3000) {
  discoveryUdp.begin(discoveryPort);
  discoveryUdp.beginPacket(IPAddress(255, 255, 255, 255), discoveryPort);
  discoveryUdp.write((const uint8_t*)discoveryRequest, strlen(discoveryRequest));
  discoveryUdp.endPacket();

  bool found = false;
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    int packetSize = discoveryUdp.parsePacket();
    if (packetSize > 0) {
      char buf[32];
      int len = discoveryUdp.read(buf, sizeof(buf) - 1);
      buf[len] = 0;
      if (strncmp(buf, discoveryReply, strlen(discoveryReply)) == 0) {
        IPAddress backendIP = discoveryUdp.remoteIP();
        backendUrl = String("http://") + backendIP.toString() + ":" + backendPort + "/update";
        Serial.print("Discovered backend at: ");
        Serial.println(backendUrl);
        found = true;
        break;
      }
    }
    delay(20);
  }
  discoveryUdp.stop();
  return found;
}

void setup() {
  Serial.begin(115200);
  sensors.begin();
  analogSetAttenuation(ADC_11db);
  pinMode(FLOW_PIN, INPUT_PULLUP); // YF-S201's open-collector output needs a pull-up
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onFlowPulse, RISING);
  loadWifiCredentials(); // NVS if previously provisioned via USB, else the hardcoded defaults
  loadBackendHost(); // NVS if a fixed backend was set via USB, else "" (same-LAN auto-discovery)
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  WiFi.begin(currentSsid.c_str(), currentPassword.c_str()); // <-- This automatically gets a DYNAMIC IP via DHCP

  // Bounded, not infinite: stored credentials could be wrong (a mistyped WIFI_SET password,
  // or a network that's since gone away), and an unconditional infinite wait here would brick
  // the board's ability to be reconfigured over USB -- readSerialCommands() below keeps
  // WIFI_SCAN/WIFI_SET usable the whole time, so a bad password is recoverable immediately
  // rather than requiring a re-flash. Falls through to loop() on timeout either way; loop()
  // keeps retrying discovery/WiFi status independently.
  unsigned long wifiWaitStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiWaitStart < 20000) {
    readSerialCommands();
    delay(200);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected!");
    Serial.print("Dynamic IP Assigned: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nStill not connected after 20s -- continuing anyway. Use WIFI_SCAN/WIFI_SET over serial to reconfigure, or wait for a retry.");
  }

  if (MDNS.begin("hydromonitor")) {
    Serial.println("mDNS responder started! You can use: hydromonitor.local");
  } else {
    Serial.println("Error setting up MDNS responder!");
  }

  if (currentBackendHost.length() > 0) {
    // Fixed backend configured over USB (possibly on a different network) -- skip LAN
    // discovery entirely.
    applyBackendHost();
  } else {
    Serial.println("Searching for backend server...");
    // Only attempts discovery while actually connected -- if the 20s WiFi wait above timed
    // out, this loop is skipped entirely and setup() falls through to loop(), where both WiFi
    // and backend discovery keep retrying independently on their own timers. backendKnown is
    // set from `discovered` itself (not inferred from WiFi.status() afterward) since WiFi could
    // in principle drop mid-retry without discovery ever having actually succeeded.
    bool discovered = false;
    while (WiFi.status() == WL_CONNECTED && !discovered) {
      readSerialCommands();
      discovered = discoverBackend();
      if (!discovered) Serial.println("Backend not found, retrying...");
    }
    backendKnown = discovered;
  }
}

void loop() {
  // Checked every iteration, not gated by broadcastInterval, so WIFI_SCAN/WIFI_SET/WIFI_STATUS
  // stay responsive over USB at any time -- the whole point of "usable anytime the ESP32 is on
  // USB," not just during initial setup().
  readSerialCommands();

  unsigned long currentMillis = millis();
  if (currentMillis - lastBroadcastTime >= broadcastInterval) {
    lastBroadcastTime = currentMillis;

    if (!backendKnown) {
      if (currentBackendHost.length() > 0) {
        // Fixed backend: nothing to rediscover, just resume posting to it. The failure
        // was presumably transient Wi-Fi/routing, not the backend's IP changing.
        applyBackendHost();
        consecutiveFailures = 0;
      } else if (discoverBackend()) {
        backendKnown = true;
        consecutiveFailures = 0;
      } else {
        Serial.println("Still searching for backend...");
      }
    }

    sensors.requestTemperatures();
    float temperatureC = sensors.getTempCByIndex(0);
    if (temperatureC == DEVICE_DISCONNECTED_C) temperatureC = 0.0;

    // Turbidity is reported as the averaged raw ADC value (mean of 20 samples, matching
    // the sketch_jul13a bench test) rather than the NTU formula: the NTU curve was
    // unstable through the voltage divider, and averaging smooths out electrical noise.
    const int turbiditySamples = 20;
    long turbidityAdcSum = 0;
    for (int i = 0; i < turbiditySamples; i++) {
      turbidityAdcSum += analogRead(TURBIDITY_PIN); // ESP32 ADC: 12-bit, 0-4095
      delay(10);
    }
    float turbidityADC = (float)turbidityAdcSum / turbiditySamples;
    Serial.printf("Turbidity avgADC=%.0f\n", turbidityADC);

    // TDS is sent as the raw sensor voltage; the backend now owns the DFRobot ppm formula,
    // its temperature compensation, and the calibration k-factor (see main.py apply_tds),
    // so the meter can be recalibrated live without reflashing this board. The board still
    // sends temperature so the backend can do the temperature compensation.
    int rawTdsValue = analogRead(TDS_PIN);
    float tdsVoltage = rawTdsValue * (adcVref / 4095.0);
    Serial.printf("TDS raw=%d tdsV=%.3f\n", rawTdsValue, tdsVoltage);

    // Snapshot-and-reset the pulse count accumulated since the last tick (~broadcastInterval
    // worth of pulses). The critical section is brief (a single read+assignment), so it
    // doesn't meaningfully delay the ISR or the other sensor reads above.
    portENTER_CRITICAL(&flowMux);
    unsigned long flowPulses = flowPulseCount;
    flowPulseCount = 0;
    portEXIT_CRITICAL(&flowMux);
    Serial.printf("Flow pulses=%lu\n", flowPulses);

    StaticJsonDocument<256> jsonDoc;
    jsonDoc["temperature"] = temperatureC;
    jsonDoc["turbidity"] = turbidityADC;
    jsonDoc["tdsVoltage"] = tdsVoltage;
    jsonDoc["flowPulses"] = flowPulses;

    String outputPayload;
    serializeJson(jsonDoc, outputPayload);

    bool backendPostFailed = false;

    if (backendKnown) {
      if (WiFi.status() == WL_CONNECTED) {
        HTTPClient http;
        WiFiClientSecure secureClient;
        WiFiClient plainClient;
        bool https = backendUrl.startsWith("https://");
        if (https) {
          // No cert store on this board -- setInsecure() skips server certificate validation,
          // same trust model as an ESP32 talking to a self-signed cert with no easy way to
          // pin/rotate a CA. This still encrypts the API key and payload in transit (the actual
          // reason for HTTPS here -- see BACKEND_SET's header comment), it just doesn't
          // authenticate the server; that's an acceptable tradeoff for a hobby monitoring
          // board, not for anything security-critical.
          secureClient.setInsecure();
          http.begin(secureClient, backendUrl);
        } else {
          http.begin(plainClient, backendUrl);
        }
        http.addHeader("Content-Type", "application/json");
        if (currentApiKey.length() > 0) {
          http.addHeader("X-API-Key", currentApiKey);
        }
        int httpCode = http.POST(outputPayload);

        if (httpCode > 0) {
          Serial.printf("POST %s -> %d\n", backendUrl.c_str(), httpCode);
          String response = http.getString();
          if (response.length() > 0) {
            Serial.println(response);
          }
          consecutiveFailures = 0;
        } else {
          Serial.printf("HTTP POST failed: %s\n", http.errorToString(httpCode).c_str());
          consecutiveFailures++;
          backendPostFailed = true;
          if (consecutiveFailures >= maxFailuresBeforeRediscover) {
            Serial.println("Backend unreachable; will re-discover its IP.");
            backendKnown = false;
            consecutiveFailures = 0;
          }
        }
        http.end();
      } else {
        Serial.println("Wi-Fi disconnected; skipping backend POST.");
      }
    }

    // IFTTT fallback: fires when the backend is unreachable (never discovered, or this
    // attempt's POST just failed) so a reading isn't silently dropped during a backend
    // outage. Needs real internet (not just LAN), and is throttled independently of the
    // 2s sensor-read cadence to respect IFTTT's free-tier rate limits.
    if ((!backendKnown || backendPostFailed) && WiFi.status() == WL_CONNECTED) {
      if (currentMillis - lastIftttPostTime >= iftttPostInterval) {
        lastIftttPostTime = currentMillis;

        StaticJsonDocument<192> iftttDoc;
        iftttDoc["value1"] = temperatureC;
        iftttDoc["value2"] = turbidityADC;
        iftttDoc["value3"] = tdsVoltage;

        String iftttPayload;
        serializeJson(iftttDoc, iftttPayload);

        WiFiClient iftttClient;
        HTTPClient iftttHttp;
        iftttHttp.begin(iftttClient, iftttWebhookUrl);
        iftttHttp.addHeader("Content-Type", "application/json");
        int iftttHttpCode = iftttHttp.POST(iftttPayload);
        Serial.printf("IFTTT fallback POST -> %d\n", iftttHttpCode);
        iftttHttp.end();
      }
    }
  }
}
