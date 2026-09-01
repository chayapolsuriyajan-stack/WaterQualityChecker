# HydroMonitor — Aqua Monitor

Real-time water quality monitoring for the Ang Kaew reservoir, Chiang Mai University. An
ESP32 board reads temperature, turbidity, and dissolved solids from the water and streams
them to a live, bilingual (English/Thai) web dashboard.

**🇬🇧 [English](#english) · 🇹🇭 [ภาษาไทย](#ภาษาไทย)**

---

## English

### What it's for

Continuous water-quality monitoring instead of occasional manual sampling. A sensor
station in the reservoir reports three raw readings every 2 seconds — **temperature**,
**turbidity** (cloudiness), and **TDS** (total dissolved solids) — which the backend turns
into calibrated units, logs to Google Sheets for history, and streams live to a dashboard
built for an educational / community-monitoring setting.

### How to use

![Dashboard](docs/dashboard.png?v=49b675d)

```bash
pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
python main.py
```

Open **http://localhost:8080/** — that's the dashboard. With no sensor station connected
yet, the cards show "no readings yet" rather than fake numbers (this project never
fabricates data — a disconnected sensor should look disconnected, not like the water is
quietly changing).

The dashboard has a left sidebar with three tabs:

- **Dashboard** — a Water Quality Index (WQI) trend chart with a selectable time range
  (5 min to 24 hours) and reference lines marking the safe bands; a live 2×2 grid of
  Temperature / Turbidity / TDS / EC cards, each with a 30-second sparkline. **Click any
  card** to open a detail view: a bigger chart with numeric point labels and two-sided
  (too‑high / too‑low) threshold lines, min/avg/max for the selected window, a plain-language
  explanation of the parameter (including what the unit abbreviations actually mean), and —
  only when the reading is actually out of range — its likely impact and a recommendation.
  A **Quick View** card summarises everything at a glance: the overall WQI badge, one row
  per parameter, and a single sentence saying what the water is doing right now. A reading
  that sits implausibly at ~0 is flagged as **"sensor not connected"** rather than shown as
  a real measurement.
- **Calibration** — turbidity (2‑point) and TDS (single-point k-factor) calibration wired to
  the sensors themselves: dip the probe in a known reference, capture the reading, save. No
  firmware reflash needed. Includes an observed min/max range with one-click "use min" /
  "use max" buttons while a turbidity probe is settling.
- **History** — a sortable table of past readings with CSV export.

A theme toggle (light/dark) and a language switcher (English ⇄ ไทย) live in the sidebar too.
The layout is fully responsive — phone, tablet, and desktop all get a layout suited to the
screen. On a first visit a short **guided tour** walks through the sidebar, the parameter
grid, the Quick View card, and the calibration tab; it can be replayed any time from the
help button in the sidebar.

### How it works, briefly

```
ESP32 station ──raw readings──▶  FastAPI server (main.py)  ──live──▶  Web dashboard
 (temp, turbidity ADC,           - converts raw → NTU / ppm            (WebSocket)
  TDS voltage)  every 2s           using saved calibration      ──log──▶ Google Sheets
      ▲                          - broadcasts to dashboards              (history, newest
      └── finds the server via   - serves the dashboard + API            row at the top)
          UDP broadcast
```

- **Station** ([`firmware/esp32/esp32.ino`](firmware/esp32/esp32.ino)) reads the three
  sensors and POSTs **raw** values to the server, discovering the server's IP automatically
  over the network so it keeps working if the server's IP changes.
- **Server** ([`main.py`](main.py), FastAPI) converts raw values to real units using the
  calibration saved on the server (not the firmware), pushes live readings to every open
  dashboard, and relays each reading to Google Sheets. No fake-data fallback anywhere in
  this chain — a real outage looks like an outage.
- **Dashboard** ([`frontend/`](frontend/) — Vite + React + TypeScript + Tailwind) subscribes
  to the live stream and renders everything above.

**If the server is unreachable**, readings are not simply lost:

- The station falls back to posting to an **IFTTT Maker Webhooks** applet (once a minute, to
  stay inside the free tier), which parks the reading in an `IFTTT_Buffer` tab of the same
  spreadsheet. A scheduled Apps Script job (`migrateIftttBuffer`) folds those rows back into
  the main sheet in the normal order. This needs a one-time manual setup in the IFTTT and
  Apps Script UIs — see the comments at the top of
  [`google_apps_script.gs`](google_apps_script.gs).
- On the server side, if the in-memory live buffer has a gap (the server restarted mid-window),
  `/history` falls back to Google Sheets for that window rather than showing a hole.

More detail — wiring, the calibration math, the Google Sheets contract, the frontend's
architecture — is in [`CLAUDE.md`](CLAUDE.md).

### Known gaps / where to improve it next

Honest status, roughly in priority order:

1. **The Google Apps Script webhook URL is committed** in [`webconfig.json`](webconfig.json),
   and `POST /update` has no authentication. Anyone who can reach the server (or that URL)
   can write readings. Move the URL to an environment variable and add a shared-secret
   header on `/update`.
2. ~~**Nothing restarts the server.**~~ **Fixed** — `scripts/install-service.ps1` installs the
   backend as a Windows service via NSSM (restart-on-failure, rotated logs in `logs/`). Run it
   from an elevated prompt. Autoreload is now off unless you set `HYDRO_DEV=1`, so a
   calibration save no longer bounces the server and drops every dashboard.
3. **No tests, no linting on the backend.** `main.py` holds the calibration math, the WQI
   inputs, and the history windowing with no test coverage; the ESP32 ⇄ backend JSON contract
   is only checked by hand. Unit tests around `apply_turbidity` / `apply_tds` / `get_history`
   would be the highest-value first ones.
4. **Calibration provenance is unverified.** `calibration.json` is git-ignored and its
   coefficients were not captured against certified reference solutions, so NTU and ppm are
   currently indicative rather than trustworthy. Recalibrate against known standards and
   record when/with what.
5. **Long history depends entirely on Google Sheets.** `/history` answers short windows from
   the in-memory buffer, but anything the buffer doesn't cover falls back to a network round
   trip to Google Sheets — no local database backs reading history. Deliberate: SQLite is
   reserved for push subscriptions and daily water usage only.
6. **Wi-Fi credentials and the IFTTT key are hardcoded** in
   [`firmware/esp32/esp32.ino`](firmware/esp32/esp32.ino), so sharing the sketch means
   sharing secrets, and moving networks means a reflash. A WiFiManager-style captive portal
   would fix both.
7. ~~**Docs drift.**~~ **Fixed** — `CLAUDE.md` no longer describes the deleted `server.js`
   relay or the `/classic` dashboard, and the dead `NoStoreStaticFiles` class documenting the
   removed `web-react/` bundle is gone from `main.py`.

---

## ภาษาไทย

### จุดประสงค์ของโปรเจกต์นี้

ระบบตรวจสอบคุณภาพน้ำแบบต่อเนื่อง แทนการเก็บตัวอย่างด้วยมือเป็นครั้งคราว สถานีเซนเซอร์ในอ่างเก็บน้ำ
ส่งค่าดิบ 3 ค่าทุก 2 วินาที ได้แก่ **อุณหภูมิ**, **ความขุ่น** (turbidity) และ **TDS**
(ปริมาณสารละลายทั้งหมด) ซึ่งเซิร์ฟเวอร์จะแปลงเป็นหน่วยที่ปรับเทียบแล้ว บันทึกประวัติลง Google Sheets
และส่งขึ้นแดชบอร์ดแบบเรียลไทม์ ออกแบบมาเพื่อใช้งานในบริบทการศึกษาและการติดตามของชุมชน

### วิธีใช้งาน

![แดชบอร์ด](docs/dashboard.png?v=49b675d)

```bash
pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
python main.py
```

เปิด **http://localhost:8080/** จะพบแดชบอร์ด หากยังไม่ได้เชื่อมต่อสถานีเซนเซอร์ การ์ดแต่ละใบจะแสดง
"ยังไม่มีข้อมูล" แทนที่จะแสดงตัวเลขปลอม (โปรเจกต์นี้ไม่มีการสร้างข้อมูลปลอมเด็ดขาด — เซนเซอร์ที่ขาดการเชื่อมต่อ
ควรแสดงผลว่าขาดการเชื่อมต่อจริง ไม่ใช่ทำให้ดูเหมือนน้ำกำลังเปลี่ยนแปลงอยู่)

แดชบอร์ดมีแถบเมนูด้านซ้ายพร้อม 3 แท็บ:

- **แดชบอร์ด** — กราฟแนวโน้มดัชนีคุณภาพน้ำ (WQI) พร้อมตัวเลือกช่วงเวลา (5 นาที ถึง 24 ชั่วโมง)
  และเส้นอ้างอิงระบุช่วงค่าที่ปลอดภัย, ตารางการ์ดแบบเรียลไทม์ 2×2 สำหรับ อุณหภูมิ / ความขุ่น / TDS / EC
  แต่ละใบมีกราฟเส้นย่อยของ 30 วินาทีล่าสุด **คลิกที่การ์ดใดก็ได้** เพื่อเปิดมุมมองรายละเอียด: กราฟขนาดใหญ่พร้อมตัวเลข
  กำกับแต่ละจุดและเส้นเกณฑ์แบบสองด้าน (สูงเกินไป / ต่ำเกินไป), ค่าต่ำสุด/เฉลี่ย/สูงสุดของช่วงเวลาที่เลือก,
  คำอธิบายค่าพารามิเตอร์แบบเข้าใจง่าย (รวมถึงความหมายเต็มของหน่วยที่ใช้) และ — เฉพาะเมื่อค่านั้นอยู่นอกช่วงปกติจริง —
  ผลกระทบที่อาจเกิดขึ้นพร้อมคำแนะนำ นอกจากนี้ยังมีการ์ด **Quick View** สรุปภาพรวมในที่เดียว: ป้าย WQI โดยรวม,
  หนึ่งแถวต่อหนึ่งพารามิเตอร์ และประโยคสรุปสั้น ๆ ว่าน้ำตอนนี้เป็นอย่างไร หากค่าที่อ่านได้ต่ำผิดปกติจนเกือบเป็นศูนย์
  ระบบจะแจ้งว่า **"เซนเซอร์ไม่ได้เชื่อมต่อ"** แทนที่จะแสดงเป็นค่าที่วัดได้จริง
- **ปรับเทียบเซนเซอร์** — ปรับเทียบความขุ่น (2 จุด) และ TDS (ค่า k-factor จุดเดียว) เชื่อมกับเซนเซอร์จริง:
  จุ่มหัววัดในสารละลายอ้างอิงที่ทราบค่า บันทึกค่าที่อ่านได้ แล้วบันทึกผล ไม่ต้องอัปโหลดเฟิร์มแวร์ใหม่
  มีการติดตามค่าต่ำสุด/สูงสุดที่พบระหว่างการปรับเทียบ พร้อมปุ่ม "ใช้ค่าต่ำสุด" / "ใช้ค่าสูงสุด" กดครั้งเดียวใช้ได้เลย
- **ประวัติ** — ตารางค่าที่บันทึกไว้ในอดีต เรียงลำดับได้ และส่งออกเป็นไฟล์ CSV

ปุ่มสลับธีม (สว่าง/มืด) และปุ่มเปลี่ยนภาษา (English ⇄ ไทย) อยู่ในแถบเมนูด้านซ้ายเช่นกัน
หน้าจอปรับตามขนาดอุปกรณ์ได้เต็มรูปแบบ ไม่ว่าจะเป็นมือถือ แท็บเล็ต หรือคอมพิวเตอร์
เมื่อเข้าใช้งานครั้งแรกจะมี **ทัวร์แนะนำการใช้งาน** พาดูแถบเมนู, ตารางพารามิเตอร์, การ์ด Quick View
และแท็บปรับเทียบเซนเซอร์ และสามารถเปิดดูซ้ำได้จากปุ่มช่วยเหลือในแถบเมนู

### หลักการทำงานโดยสรุป

```
สถานี ESP32 ──ค่าดิบ──▶  เซิร์ฟเวอร์ FastAPI (main.py)  ──เรียลไทม์──▶  เว็บแดชบอร์ด
 (อุณหภูมิ, ADC ความขุ่น,      - แปลงค่าดิบ → NTU / ppm                (WebSocket)
  แรงดัน TDS) ทุก 2 วิ           โดยใช้ค่าปรับเทียบที่บันทึกไว้    ──บันทึก──▶ Google Sheets
      ▲                       - ส่งกระจายไปยังแดชบอร์ด                  (ประวัติ, แถวล่าสุด
      └── หาเซิร์ฟเวอร์ผ่าน       - ให้บริการแดชบอร์ด + API                 อยู่บนสุด)
          การกระจายสัญญาณ UDP
```

- **สถานีเซนเซอร์** ([`firmware/esp32/esp32.ino`](firmware/esp32/esp32.ino)) อ่านค่าจากเซนเซอร์ทั้ง 3 ตัว
  แล้วส่งค่า **ดิบ** ไปยังเซิร์ฟเวอร์ โดยค้นหา IP ของเซิร์ฟเวอร์เองผ่านเครือข่าย จึงยังทำงานต่อได้แม้ IP
  ของเซิร์ฟเวอร์จะเปลี่ยน
- **เซิร์ฟเวอร์** ([`main.py`](main.py), FastAPI) แปลงค่าดิบเป็นหน่วยจริงโดยใช้ค่าปรับเทียบที่บันทึกไว้ที่เซิร์ฟเวอร์
  (ไม่ใช่ที่เฟิร์มแวร์) ส่งค่าล่าสุดไปยังทุกแดชบอร์ดที่เปิดอยู่ และส่งต่อแต่ละค่าไปบันทึกที่ Google Sheets
  ไม่มีการสร้างข้อมูลปลอมในทุกจุดของระบบ — เมื่อเกิดปัญหาจริงจะแสดงผลตรงตามความเป็นจริง
- **แดชบอร์ด** ([`frontend/`](frontend/) — Vite + React + TypeScript + Tailwind)
  รับข้อมูลแบบเรียลไทม์และแสดงผลทั้งหมดข้างต้น

**หากติดต่อเซิร์ฟเวอร์ไม่ได้** ข้อมูลจะไม่สูญหายไปเฉย ๆ:

- สถานีจะเปลี่ยนไปส่งค่าไปยัง **IFTTT Maker Webhooks** แทน (นาทีละครั้ง เพื่อให้อยู่ในโควตาของแพ็กเกจฟรี)
  ซึ่งจะพักข้อมูลไว้ในแท็บ `IFTTT_Buffer` ของสเปรดชีตเดียวกัน แล้วสคริปต์ตามเวลา (`migrateIftttBuffer`)
  จะย้ายแถวเหล่านั้นกลับเข้าชีตหลักตามลำดับปกติ ทั้งหมดนี้ต้องตั้งค่าด้วยมือครั้งเดียวในหน้าเว็บของ IFTTT
  และ Apps Script — ดูคำอธิบายด้านบนของไฟล์ [`google_apps_script.gs`](google_apps_script.gs)
- ฝั่งเซิร์ฟเวอร์ หากบัฟเฟอร์ข้อมูลสดในหน่วยความจำมีช่วงที่ขาดหาย (เช่น เซิร์ฟเวอร์รีสตาร์ทกลางคัน)
  `/history` จะดึงข้อมูลช่วงนั้นจาก Google Sheets แทน แทนที่จะแสดงกราฟที่มีช่องว่าง

### ข้อจำกัดที่ยังมีอยู่ / สิ่งที่ควรปรับปรุงต่อไป

สถานะตามความเป็นจริง เรียงตามความสำคัญคร่าว ๆ:

1. **URL ของ Google Apps Script ถูกคอมมิตไว้ในโค้ด** ([`webconfig.json`](webconfig.json)) และ
   `POST /update` ไม่มีการยืนยันตัวตน ใครที่เข้าถึงเซิร์ฟเวอร์หรือ URL นั้นได้ก็เขียนข้อมูลได้
   ควรย้าย URL ไปไว้ใน environment variable และเพิ่ม shared secret ที่ `/update`
2. ~~**ไม่มีตัวคอยรีสตาร์ทเซิร์ฟเวอร์**~~ **แก้ไขแล้ว** — สคริปต์ `scripts/install-service.ps1` ติดตั้งเซิร์ฟเวอร์
   เป็น Windows service ผ่าน NSSM (รีสตาร์ทอัตโนมัติเมื่อล่ม พร้อมไฟล์ log ใน `logs/`) ให้รันจาก PowerShell
   แบบ Administrator นอกจากนี้ระบบ autoreload ถูกปิดไว้แล้ว (เปิดด้วย `HYDRO_DEV=1` เมื่อพัฒนา)
   การบันทึกค่าปรับเทียบจึงไม่ทำให้เซิร์ฟเวอร์รีสตาร์ทและตัดการเชื่อมต่อแดชบอร์ดอีกต่อไป
3. **ยังไม่มีชุดทดสอบ** ทั้งสูตรปรับเทียบ, ค่าที่ป้อนเข้า WQI และการแบ่งช่วงเวลาของ `/history` ใน `main.py`
   ยังไม่มีเทสต์ครอบคลุม และสัญญาข้อมูล JSON ระหว่าง ESP32 กับเซิร์ฟเวอร์ตรวจสอบด้วยมือล้วน ๆ
4. **ยังยืนยันที่มาของค่าปรับเทียบไม่ได้** ไฟล์ `calibration.json` ไม่ถูกเก็บใน git และค่าที่ใช้อยู่ไม่ได้เทียบกับ
   สารละลายมาตรฐานที่รับรองแล้ว ค่า NTU และ ppm จึงยังเป็นค่าบ่งชี้ ไม่ใช่ค่าที่เชื่อถือได้เต็มที่
5. **ประวัติย้อนหลังพึ่ง Google Sheets ทั้งหมด** `/history` ตอบช่วงเวลาสั้น ๆ จากบัฟเฟอร์ในหน่วยความจำ
   แต่ช่วงที่บัฟเฟอร์ไม่ครอบคลุมต้องย้อนไปขอ Google Sheets ผ่านเครือข่ายทุกครั้ง — ไม่มีฐานข้อมูลในเครื่อง
   รองรับประวัติการอ่านค่า (ตั้งใจให้ SQLite เก็บเฉพาะการสมัครรับ push notification และปริมาณการใช้น้ำรายวันเท่านั้น)
6. **รหัส Wi-Fi และคีย์ IFTTT ฝังอยู่ในเฟิร์มแวร์** ([`firmware/esp32/esp32.ino`](firmware/esp32/esp32.ino))
   การแชร์โค้ดจึงเท่ากับแชร์รหัส และการย้ายเครือข่ายต้องอัปโหลดเฟิร์มแวร์ใหม่ ควรใช้ WiFiManager แบบ captive portal
7. ~~**เอกสารบางส่วนล้าสมัย**~~ **แก้ไขแล้ว** — `CLAUDE.md` ไม่กล่าวถึง `server.js` และหน้า `/classic`
   ที่ถูกลบไปแล้วอีกต่อไป และคลาส `NoStoreStaticFiles` ที่ไม่ได้ใช้งาน (อธิบายถึง `web-react/` ที่ถูกลบไปแล้ว)
   ก็ถูกนำออกจาก `main.py` ด้วย

รายละเอียดเพิ่มเติม — การเดินสาย, สูตรการปรับเทียบ, รูปแบบข้อมูลของ Google Sheets, สถาปัตยกรรมของฝั่งหน้าเว็บ —
อยู่ใน [`CLAUDE.md`](CLAUDE.md)
