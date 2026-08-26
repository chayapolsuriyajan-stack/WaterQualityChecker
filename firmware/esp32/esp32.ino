#include <WiFi.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include "esp_eap_client.h" // WPA2/WPA3-Enterprise (PEAP/TTLS/TLS) join, arduino-esp32 3.x (IDF5)
                            // API -- see enterpriseSsid/etc below. If this header doesn't exist
                            // on your installed core version, try "esp_wpa2.h" instead (older
                            // 2.x cores put the same esp_wifi_sta_wpa2_ent_* functions there
                            // under different names -- esp_eap_client_set_identity/username/
                            // password below would need to become esp_wifi_sta_wpa2_ent_set_*).

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
// and these consts are never consulted again. This is a WPA2-Enterprise (802.1X) network --
// not a plain password -- so it needs an identity/password rather than a single password, and
// connectWifi() below routes it through the ESP-IDF enterprise join instead of a plain
// WiFi.begin(ssid, password). There's no separate "username" here: the EAP-PEAP inner
// (MSCHAPv2) auth reuses the same identity string as its username when none is set
// separately, which matches how phone WiFi-Enterprise screens show one "Identity" field, not
// two -- see esp_eap_client_set_username's call below. FILL IN before flashing.
const char* enterpriseSsid = "@JumboPlus"; // NOT "@JumboPlus5GHz" -- ESP32 has no 5GHz radio at
                                            // all (2.4GHz 802.11b/g/n only), so a 5GHz-only SSID
                                            // can never be joined regardless of credentials/certs.
const char* enterpriseIdentity = "katunyu.h@satitcmu.ac.th";
const char* enterprisePassword = "s@1579901492444";
const int backendPort = 8080;

// Currently-active WiFi credentials, loaded from NVS at boot and updated in-memory whenever a
// WIFI_SET succeeds -- kept separately from NVS so a failed WIFI_SET can immediately retry
// these without a flash read. Only meaningful in PSK mode (wifiIsEnterpriseFallback == false);
// in enterprise-fallback mode connectWifi() ignores currentPassword entirely and uses the
// enterprise* consts above instead.
Preferences wifiPrefs;
String currentSsid;
String currentPassword;

// True only on a board that has never had a successful WIFI_SET -- i.e. nothing has ever been
// saved to NVS. Decided once here at boot; a later successful WIFI_SET flips it off in memory
// (see handleWifiSet) so the board doesn't fall back to the enterprise network again until NVS
// is erased.
bool wifiIsEnterpriseFallback = true;

void loadWifiCredentials() {
  wifiPrefs.begin("wifi", true); // read-only
  wifiIsEnterpriseFallback = !wifiPrefs.isKey("ssid"); // nothing ever saved via WIFI_SET yet
  if (wifiIsEnterpriseFallback) {
    currentSsid = enterpriseSsid; // for WIFI_STATUS/logging only
    currentPassword = "";
  } else {
    currentSsid = wifiPrefs.getString("ssid", enterpriseSsid);
    currentPassword = wifiPrefs.getString("pass", "");
  }
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

// Centralizes how the board joins WiFi, since there are now two shapes: the hardcoded
// @JumboPlus WPA2-Enterprise fallback (fresh/unprovisioned board) or a plain WPA-PSK network
// saved via WIFI_SET. Called from setup()'s initial connect and from handleWifiSet's
// revert-to-previous-network path on a failed WIFI_SET, so both stay in sync automatically
// rather than duplicating the branch.
void connectWifi() {
  if (wifiIsEnterpriseFallback) {
    esp_eap_client_set_identity((const uint8_t*)enterpriseIdentity, strlen(enterpriseIdentity));
    // No separate username field on this network -- reuse the identity string (see the
    // enterpriseIdentity comment above).
    esp_eap_client_set_username((const uint8_t*)enterpriseIdentity, strlen(enterpriseIdentity));
    esp_eap_client_set_password((const uint8_t*)enterprisePassword, strlen(enterprisePassword));
    esp_wifi_sta_enterprise_enable();
    WiFi.begin(enterpriseSsid);
  } else {
    // No-op if enterprise mode was never enabled -- required so a plain PSK join doesn't try
    // an EAP handshake against a network that isn't expecting one (e.g. right after a WIFI_SET
    // to a normal network on a board that just booted into the enterprise fallback).
    esp_wifi_sta_enterprise_disable();
    WiFi.begin(currentSsid.c_str(), currentPassword.c_str());
  }
}

// Google Sheets fallback: used only when the backend PC (main.py) can't be reached but
// Wi-Fi/internet still work, so a reading isn't silently dropped during a backend outage.
// Posts straight to the SAME Google Apps Script Web App main.py's own Sheets relay uses (see
// google_apps_script.gs's doPost) -- no third-party service, no separate account/plan, and no
// per-reading fee/rate-limit to work around, unlike the IFTTT Maker Webhooks path this
// replaced. Paste in the deployed Web App's /exec URL (Apps Script editor -> Deploy -> Web
// App; must match webconfig.json's googleSheetsWebhookUrl on the backend, since both write to
// the same sheet in the same row shape).
const char* sheetsWebhookUrl = "https://script.google.com/macros/s/AKfycbx38Bv3wlgevYq4OtxxvCrFq7atMi6PgRxF7XzTQSentBiTVAyyQbn_UTlKPPMMJc4P/exec";

// The sheet's TDS column is always ppm, never raw voltage (there's no separate raw-voltage
// column to backfill from later, unlike turbidity's raw ADC -- see google_apps_script.gs).
// Sending this fallback path's raw tdsVoltage straight into that column would show up as a
// wildly wrong ppm number (voltage is ~0-2.3, ppm is typically hundreds) and poison the
// derived EC value too. This mirrors main.py's _dfrobot_ppm (the *uncalibrated*, k=1.0 shape
// -- the personal k-factor lives in calibration.json on the backend PC, which this fallback
// path has no access to) so the units/scale are at least correct, same as what the dashboard
// already shows whenever calibration mode is off.
float dfrobotUncalibratedPpm(float voltage, float temperatureC) {
  float coeff = 1.0 + 0.02 * (temperatureC - 25.0);
  float v = (coeff != 0.0) ? voltage / coeff : voltage;
  float ppm = (133.42 * v * v * v - 255.86 * v * v + 857.39 * v) * 0.5;
  return ppm > 0.0 ? ppm : 0.0;
}

// Sensors are read every broadcastInterval (2s), but each buffered reading becomes its own
// Apps Script call once we're able to send (see the flush loop in loop() below) -- bursting
// all of them at once is inconsiderate of Apps Script's per-call execution overhead, so sends
// are throttled to one flush attempt per sheetsFallbackInterval, same spirit as the previous
// IFTTT throttle. Readings taken between flushes accumulate in a circular buffer (once full,
// the newest overwrites the oldest -- degrades to "most recent 30" instead of overflowing)
// so a 60s outage window is recovered in full, not just its last instant.
const int sheetsFallbackBufferSize = 30;
float sheetsFallbackTempBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTurbBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferSize];
int sheetsFallbackBufferCount = 0; // how many valid entries (caps at sheetsFallbackBufferSize)
int sheetsFallbackBufferNext = 0;  // next slot to write; wraps once the buffer is full

void sheetsFallbackBufferPush(float temperature, float turbidity, float tdsVoltage) {
  sheetsFallbackTempBuffer[sheetsFallbackBufferNext] = temperature;
  sheetsFallbackTurbBuffer[sheetsFallbackBufferNext] = turbidity;
  sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferNext] = tdsVoltage;
  sheetsFallbackBufferNext = (sheetsFallbackBufferNext + 1) % sheetsFallbackBufferSize;
  if (sheetsFallbackBufferCount < sheetsFallbackBufferSize) sheetsFallbackBufferCount++;
}

void sheetsFallbackBufferClear() {
  sheetsFallbackBufferCount = 0;
  sheetsFallbackBufferNext = 0;
}

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

unsigned long lastSheetsFallbackPostTime = 0;
const unsigned long sheetsFallbackInterval = 60000; // 60s, independent of broadcastInterval -- see the buffer's header comment

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
  // wifioff=true, eraseap=true: a plain WiFi.disconnect() leaves the ESP-IDF driver's own
  // cached AP association alone, and on ESP32 that can win a race against the WiFi.begin()
  // right below it -- symptom is exactly "changed the password/network over USB and the board
  // just keeps reconnecting to the OLD one" (or never leaves it). Fully tearing the radio down
  // first, then giving it a beat to settle, makes the switch to different credentials reliable.
  // Also disable enterprise mode unconditionally before this plain PSK attempt -- if the board
  // booted into the @JumboPlus enterprise fallback, leaving that enabled would make this
  // WiFi.begin(ssid, password) try an EAP handshake against a network that isn't expecting one.
  WiFi.disconnect(true, true);
  esp_wifi_sta_enterprise_disable();
  delay(200);
  WiFi.begin(newSsid.c_str(), newPassword.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(200);
  }

  if (WiFi.status() == WL_CONNECTED) {
    // Only persist on confirmed success -- a bad password never overwrites a working
    // previously-saved network (see saveWifiCredentials's header comment).
    saveWifiCredentials(newSsid, newPassword);
    wifiIsEnterpriseFallback = false; // a real PSK network now exists -- don't fall back to
                                       // the enterprise default again until NVS is erased
    backendKnown = false; // force UDP rediscovery -- the backend's IP may differ on this network
    Serial.printf("WIFI_CONNECTED|%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("WIFI_FAILED|timeout");
    // Fall back to whatever was working before (enterprise fallback or a previously-saved PSK
    // network), so a typo'd password doesn't leave the board stranded offline until the next
    // USB session. Routed through connectWifi() so this stays correct for either mode.
    WiFi.disconnect(true, true);
    delay(200);
    connectWifi();
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

// Erases any WIFI_SET-saved PSK network from NVS and reverts to the hardcoded @JumboPlus
// enterprise fallback -- needed because loadWifiCredentials() only ever picks the enterprise
// path when NVS has no saved "ssid" at all, so a board that was previously provisioned (e.g. to
// the old W7 default) would otherwise keep retrying that PSK network forever and never attempt
// enterprise mode. This is the USB-recoverable equivalent of a full flash erase, scoped to just
// the "wifi" namespace (BACKEND_* settings in the separate "backend" namespace are untouched).
void handleWifiClear() {
  wifiPrefs.begin("wifi", false); // read-write
  wifiPrefs.clear();
  wifiPrefs.end();
  WiFi.disconnect(true, true);
  delay(200);
  loadWifiCredentials(); // no "ssid" key left -> wifiIsEnterpriseFallback becomes true
  connectWifi();
  Serial.println("WIFI_CLEARED");
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

// GETs main.py's GET /update/health -- a no-op reachability/auth check that doesn't write a
// fake sensor reading, unlike POSTing to the real /update would. Exercises the exact
// URL/TLS-trust/API-key combination the real POSTs in loop() use (mirrors that block's client
// setup deliberately), so a green result here is a real guarantee the sensor path will work,
// not just that *something* answered on the host. Reports BACKEND_TEST_OK|<httpCode> on any
// HTTP response at all (even a 401 -- that's still "reachable", just misconfigured auth) or
// BACKEND_TEST_FAILED|<reason> when the request never got an HTTP response (DNS/TCP/TLS
// failure, or nothing configured yet).
void handleBackendTest() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("BACKEND_TEST_FAILED|wifi_not_connected");
    return;
  }
  if (backendUrl.length() == 0) {
    Serial.println("BACKEND_TEST_FAILED|no_backend_configured");
    return;
  }
  String healthUrl = backendUrl + "/health"; // backendUrl always ends in ".../update"

  HTTPClient http;
  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  bool https = healthUrl.startsWith("https://");
  if (https) {
    secureClient.setInsecure(); // see loop()'s POST block for why this is an accepted tradeoff
    http.begin(secureClient, healthUrl);
  } else {
    http.begin(plainClient, healthUrl);
  }
  if (currentApiKey.length() > 0) {
    http.addHeader("X-API-Key", currentApiKey);
  }
  int httpCode = http.GET();
  String failureReason = httpCode > 0 ? "" : http.errorToString(httpCode); // must read before end()
  http.end();

  if (httpCode > 0) {
    Serial.printf("BACKEND_TEST_OK|%d\n", httpCode);
  } else {
    Serial.printf("BACKEND_TEST_FAILED|%s\n", failureReason.c_str());
  }
}

void handleSerialLine(String line) {
  line.trim();
  if (line == "WIFI_SCAN") {
    handleWifiScan();
  } else if (line == "WIFI_STATUS") {
    handleWifiStatus();
  } else if (line == "WIFI_CLEAR") {
    handleWifiClear();
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
  } else if (line == "BACKEND_TEST") {
    handleBackendTest();
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
  // The ESP-IDF WiFi driver underneath Arduino keeps its OWN flash-persisted copy of the last
  // AP it connected to, separate from -- and normally invisible to -- our own credential
  // storage in wifiPrefs (NVS namespace "wifi"). WiFi.persistent(true) is the Arduino default;
  // turning it off here stops that internal store from writing on every WiFi.begin() (flash
  // wear) and, more importantly, from re-asserting a stale cached network out from under an
  // explicit reconnect to a *different* one over USB (see handleWifiSet below) -- we already
  // own persistence ourselves and always pass explicit credentials to WiFi.begin().
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  loadWifiCredentials(); // NVS if previously provisioned via USB, else the @JumboPlus enterprise fallback
  loadBackendHost(); // NVS if a fixed backend was set via USB, else "" (same-LAN auto-discovery)
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  connectWifi(); // enterprise (@JumboPlus) or plain PSK, whichever loadWifiCredentials() picked; DHCP either way

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
    // Bounded (20s, not infinite -- same reasoning as the WiFi-connect wait above): a backend
    // may never answer at all (no main.py running anywhere, e.g. Google Sheets fallback used
    // as the only destination on purpose), and an unconditional wait here would hang setup()
    // forever, which would keep loop() -- and therefore the Sheets fallback and every sensor
    // read -- from ever running. Falls through to loop() either way; loop() keeps retrying
    // discovery on its own timer, so a backend that shows up later is still picked up.
    // backendKnown is set from `discovered` itself (not inferred from WiFi.status() afterward)
    // since WiFi could in principle drop mid-retry without discovery ever having succeeded.
    bool discovered = false;
    unsigned long backendWaitStart = millis();
    while (WiFi.status() == WL_CONNECTED && !discovered && millis() - backendWaitStart < 20000) {
      readSerialCommands();
      discovered = discoverBackend();
      if (!discovered) Serial.println("Backend not found, retrying...");
    }
    backendKnown = discovered;
    if (!discovered) {
      Serial.println("No backend found after 20s -- continuing without one. Sensor reads/Sheets fallback (if configured) proceed regardless; backend discovery keeps retrying in the background.");
    }
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
          // The backend has caught up to the present again -- readings buffered for the
          // Sheets fallback while it was down have served their purpose (or will on the next
          // flush window); clear so a late-arriving flush doesn't resend now-stale readings.
          sheetsFallbackBufferClear();
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

    // Google Sheets fallback: buffers every reading taken while the backend is unreachable
    // (never discovered, or this attempt's POST just failed) so readings aren't silently
    // dropped during a backend outage, then flushes the whole buffer -- one Apps Script POST
    // per buffered reading, matching google_apps_script.gs's doPost single-reading JSON shape
    // -- no more than once per sheetsFallbackInterval so a long outage doesn't fire a burst of
    // calls too often. Needs real internet (not just LAN) and sheetsWebhookUrl filled in above.
    if ((!backendKnown || backendPostFailed) && WiFi.status() == WL_CONNECTED) {
      sheetsFallbackBufferPush(temperatureC, turbidityADC, tdsVoltage);

      if (currentMillis - lastSheetsFallbackPostTime >= sheetsFallbackInterval && sheetsFallbackBufferCount > 0) {
        lastSheetsFallbackPostTime = currentMillis;

        // Oldest entry is at sheetsFallbackBufferNext once the buffer has wrapped (that slot
        // is next to be overwritten); while still filling up for the first time, oldest is
        // just index 0 -- same logic the old IFTTT buffer join used.
        int oldestIdx = (sheetsFallbackBufferCount < sheetsFallbackBufferSize) ? 0 : sheetsFallbackBufferNext;
        int sent = 0;
        for (int i = 0; i < sheetsFallbackBufferCount; i++) {
          int idx = (oldestIdx + i) % sheetsFallbackBufferSize;

          // TDS: uncalibrated ppm (see dfrobotUncalibratedPpm's header comment above), not the
          // raw sensor voltage -- the sheet's TDS column is always ppm-shaped with no separate
          // raw-voltage column to backfill from later, unlike turbidity's raw ADC.
          StaticJsonDocument<192> sheetsDoc;
          sheetsDoc["temperature"] = sheetsFallbackTempBuffer[idx];
          sheetsDoc["turbidity"] = sheetsFallbackTurbBuffer[idx];
          sheetsDoc["tds"] = dfrobotUncalibratedPpm(sheetsFallbackTdsVoltageBuffer[idx], sheetsFallbackTempBuffer[idx]);

          String sheetsPayload;
          serializeJson(sheetsDoc, sheetsPayload);

          WiFiClientSecure sheetsClient;
          // Apps Script's cert is a real public CA in practice, but this board has no CA
          // store to validate against -- same accepted tradeoff as the fixed-backend HTTPS
          // path above (encrypts in transit, doesn't authenticate the server).
          sheetsClient.setInsecure();
          HTTPClient sheetsHttp;
          sheetsHttp.begin(sheetsClient, sheetsWebhookUrl);
          sheetsHttp.addHeader("Content-Type", "application/json");
          int sheetsHttpCode = sheetsHttp.POST(sheetsPayload);
          sheetsHttp.end();
          if (sheetsHttpCode > 0) sent++;
        }
        Serial.printf("Sheets fallback flush: %d/%d buffered readings sent\n", sent, sheetsFallbackBufferCount);

        // Sent (or at least attempted) -- start the next window's buffer fresh regardless of
        // per-reading success, matching the existing fire-and-forget posture elsewhere in this
        // sketch (a lost reading here is already best-effort, same as the previous IFTTT path).
        sheetsFallbackBufferClear();
      }
    }
  }
}
