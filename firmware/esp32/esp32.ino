#include <WiFi.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

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

const char* ssid = "W7";
const char* password = "Asdfghjkl";
const int backendPort = 8080;

// IFTTT Maker Webhooks fallback: used only when the backend PC (main.py) can't be reached but
// Wi-Fi/internet still work, so a reading isn't silently dropped during a backend outage.
// Fill in iftttWebhookKey with your own key from https://ifttt.com/maker_webhooks (the
// "Documentation" link on that page shows your personal key). iftttEventName must match the
// event name configured in the IFTTT applet's Webhooks "Receive a web request" trigger.
const char* iftttEventName = "hydro_reading";
const char* iftttWebhookKey = "YOUR_IFTTT_WEBHOOKS_KEY"; // <-- fill in your own key
const String iftttWebhookUrl = "https://maker.ifttt.com/trigger/" + String(iftttEventName) + "/with/key/" + String(iftttWebhookKey);

// Backend IP is found at runtime via UDP broadcast discovery (see discoverBackend())
// instead of being hardcoded, so the sketch keeps working after the backend PC's
// DHCP-assigned IP changes. main.py must be running its discovery listener on this port.
const unsigned int discoveryPort = 8888;
const char* discoveryRequest = "HYDRO_DISCOVER";
const char* discoveryReply = "HYDRO_HERE";
WiFiUDP discoveryUdp;

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
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  WiFi.begin(ssid, password); // <-- This automatically gets a DYNAMIC IP via DHCP

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nConnected!");
  Serial.print("Dynamic IP Assigned: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("hydromonitor")) {
    Serial.println("mDNS responder started! You can use: hydromonitor.local");
  } else {
    Serial.println("Error setting up MDNS responder!");
  }

  Serial.println("Searching for backend server...");
  while (!discoverBackend()) {
    Serial.println("Backend not found, retrying...");
  }
  backendKnown = true;
}

void loop() {
  unsigned long currentMillis = millis();
  if (currentMillis - lastBroadcastTime >= broadcastInterval) {
    lastBroadcastTime = currentMillis;

    if (!backendKnown) {
      if (discoverBackend()) {
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
        WiFiClient client;
        HTTPClient http;
        http.begin(client, backendUrl);
        http.addHeader("Content-Type", "application/json");
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
