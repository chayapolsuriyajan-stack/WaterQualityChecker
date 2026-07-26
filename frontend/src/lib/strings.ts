/**
 * Single UI-text catalogue for the Aqua Monitor frontend. Every user-facing
 * string in the app lives here as a flat dot-key -> string map, in both `en`
 * and `th`, with identical key sets. No logic, no JSX, just text.
 *
 * Copy conventions:
 * - Short labels and buttons have no trailing period; full sentences do.
 * - Ellipses are three ASCII dots, never the single-character ellipsis.
 * - No em or en dashes anywhere. Use a period, comma, or parentheses instead.
 * - Language names are written natively ("English", "ไทย") in both locales.
 *
 * Interpolation: use `{placeholder}` tokens, resolved by `useT().t(key, vars)`
 * in lib/i18n.tsx, e.g. t('detail.dataPoints', { count: 42 }).
 */

export type Lang = 'en' | 'th'

const en = {
  // --- nav ---------------------------------------------------------------
  'nav.dashboard': 'Dashboard',
  'nav.calibration': 'Calibration',
  'nav.history': 'History',

  // --- app shell -----------------------------------------------------------
  'app.title': 'Aqua Monitor',
  'app.siteName': 'Ang Kaew Reservoir',
  'app.siteNameShort': 'Ang Kaew',
  'app.subtitle': 'Chiang Mai University',

  // --- user ----------------------------------------------------------------
  'user.guest': 'Guest',
  'user.role': 'View only',
  'user.signOut': 'Sign out',

  // --- status ----------------------------------------------------------------
  'status.good': 'Good',
  'status.caution': 'Caution',
  'status.danger': 'Danger',
  'status.unknown': 'Unknown',
  'status.safe': 'Safe',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.noData': 'No data',

  // --- history/chart time range --------------------------------------------
  'window.5m': '5 min',
  'window.15m': '15 min',
  'window.1h': '1 hour',
  'window.3h': '3 hours',
  'window.12h': '12 hours',
  'window.24h': '24 hours',
  'window.label': 'Time range',

  // --- parameters ------------------------------------------------------------
  'param.temperature.label': 'Temperature',
  'param.temperature.about':
    'Water temperature sets how much oxygen the water can hold and how fast aquatic life uses it.',
  'param.temperature.impact':
    'Readings outside the normal range stress fish and other aquatic life, and can speed up algae growth.',
  'param.temperature.recommendation':
    'Check the shading, the inflow, and whether the probe has shifted. Watch the next few readings before acting.',

  'param.turbidity.label': 'Turbidity',
  'param.turbidity.about':
    'Turbidity is a measure of the particles suspended in the water, which limit how far light reaches.',
  'param.turbidity.impact':
    'High turbidity keeps sunlight from reaching aquatic plants. It often points to runoff, stirred sediment, or an algae bloom.',
  'param.turbidity.recommendation':
    'Check for recent rain or upstream disturbance. If the reading stays high, clean the sensor lens.',

  'param.tds.label': 'TDS',
  'param.tds.about':
    'Total dissolved solids is the amount of minerals and salts dissolved in the water, measured in parts per million.',
  'param.tds.impact':
    'TDS outside the normal range can change the taste of the water, point to contamination, or stress freshwater life.',
  'param.tds.recommendation':
    'Compare it against the recent trend. If the reading is unusually high, check for runoff or discharge nearby.',

  'param.ec.label': 'EC',
  'param.ec.about':
    'Electrical conductivity comes from the ions dissolved in the water, so it tracks closely with TDS.',
  'param.ec.impact':
    'An unusual EC reading means the dissolved salts or minerals have changed, which can point to pollution or mineral runoff.',
  'param.ec.recommendation':
    'Check the TDS reading too, since EC is derived from it. A sudden change in both is worth investigating.',

  // --- parameter detail modal ------------------------------------------------
  'detail.currentValue': 'Current value',
  'detail.noRecord': 'No readings yet',
  'detail.dataPoints': '{count} data points',
  'detail.min': 'Min',
  'detail.avg': 'Avg',
  'detail.max': 'Max',
  'detail.tooHigh': '{param} is above the safe range ({value} {unit})',
  'detail.tooLow': '{param} is below the safe range ({value} {unit})',
  'detail.checkSensor': 'This reading is too low to be real. Check the sensor rather than the water.',
  'detail.normalRange': 'Normal range: {range}',
  'detail.aboutTitle': 'About',
  'detail.impactTitle': 'Impact',
  'detail.recommendationTitle': 'Recommendation',
  'detail.chartCaption': 'Live sensor data. Pick a time range above.',

  // --- WQI ---------------------------------------------------------------
  'wqi.title': 'Water Quality Index (WQI)',
  'wqi.moderate': 'Moderate',
  'wqi.good': 'Good',
  'wqi.empty': 'No history yet for this time range.',
  'wqi.error': "Couldn't load history for this time range.",

  // --- calibration ---------------------------------------------------------
  'calib.title': 'Sensor Calibration',
  'calib.subtitle': 'Calibrate while the sensors keep running, without uploading new firmware.',
  'calib.modeLabel': 'Calibration mode',
  'calib.modeOn': 'ON',
  'calib.modeOff': 'OFF',
  'calib.applyingTurbidity': 'Applying turbidity calibration...',
  'calib.applyingTds': 'Applying TDS calibration...',
  'calib.failedTurbidity': "Couldn't apply the turbidity calibration",
  'calib.failedTds': "Couldn't apply the TDS calibration",
  'calib.resetSuccess': 'Calibration reset',
  'calib.resetFailed': "Couldn't reset",
  'calib.modeChangeFailed': "Couldn't change the mode",
  'calib.temperatureTitle': 'Temperature',
  'calib.noCalibrationNeeded': 'No calibration needed',
  'calib.factoryCalibrated': 'Factory calibrated (DS18B20 ±0.5°C)',
  'calib.ecTitle': 'Electrical Conductivity (EC)',
  'calib.noSeparateSensor': 'No separate sensor',
  'calib.derivedFromTds': 'Derived from TDS (×0.5). Calibrate it through TDS.',
  'calib.resetTurbidity': 'Reset turbidity',
  'calib.resetTds': 'Reset TDS',
  'calib.observedRange': 'Observed while calibrating: {min} min, {max} max',
  'calib.useMin': 'Use min',
  'calib.useMax': 'Use max',
  'calib.resetRange': 'Reset range',
  'calib.loading': 'Loading...',
  'calib.sensorSelectAria': 'Sensor selection',
  'calib.turbidityFormTitle': 'Turbidity calibration (2-point)',
  'calib.turbidityReferenceLabel': 'Standard value (NTU)',
  'calib.turbidityRawLabel': 'Measured (raw ADC)',
  'calib.turbidityRawHint': 'Leave blank to use the live reading',
  'calib.tdsFormTitle': 'TDS calibration (k-factor)',
  'calib.tdsReferenceLabel': 'Known ppm (reference)',
  'calib.tdsRawLabel': 'Measured (ppm, optional)',
  'calib.tdsRawHint':
    'Preview only, never sent to the server. Enter the uncalibrated ppm reading, not the raw voltage.',
  'calib.applyLabel': 'Apply',
  'calib.applying': 'Applying...',
  'calib.needTwoPoints': 'Needs 2 points',
  'calib.singlePoint': 'Single point',
  'calib.liveReading': 'Live reading',
  'calib.pointLabel': 'Point {n}',
  'calib.savedPoints': 'Saved points',
  'calib.deletePoint': 'Delete point',
  'calib.coefficientsTitle': 'Coefficients',
  'calib.pending': 'Unconfirmed',
  'calib.notCalibrated': 'Not calibrated yet',
  'calib.needTurbidityPoints': '2 points',
  'calib.needTdsPoints': '1 point',
  'calib.currentResult': 'Current result',
  'calib.kFactorFormula': 'Calibrated ppm = k × raw DFRobot reading',
  'calib.lastSaved': 'Last saved',

  // --- history table ---------------------------------------------------------
  'history.title': 'History',
  'history.loading': 'Loading...',
  'history.failed': "Couldn't load the data",
  'history.empty': 'No data in this time range',
  'history.exportCsv': 'Export CSV',
  'history.col.time': 'Time',
  'history.col.temperature': 'Temperature (°C)',
  'history.col.turbidity': 'Turbidity',
  'history.col.tds': 'TDS (ppm)',
  'history.col.ec': 'EC (µS/cm)',
  'history.col.status': 'Status',
  'history.rowCount': '{count} readings from {source}',
  'history.refreshing': 'refreshing...',

  // --- common ------------------------------------------------------------
  'common.close': 'Close',
  'common.reload': 'Reload',
  'common.error': 'Something went wrong.',
  'common.openMenu': 'Open menu',
  'common.loading': 'Loading...',
  'common.uncalibrated': 'Uncalibrated (raw ADC)',

  // --- theme ---------------------------------------------------------------
  'theme.toggle': 'Toggle theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  // --- language ------------------------------------------------------------
  'lang.switch': 'Switch language',
  'lang.en': 'English',
  'lang.th': 'ไทย',
} as const

export const messages = {
  en,
  th: {
    'nav.dashboard': 'แดชบอร์ด',
    'nav.calibration': 'ปรับเทียบ',
    'nav.history': 'ประวัติ',

    'app.title': 'Aqua Monitor',
    'app.siteName': 'อ่างเก็บน้ำอ่างแก้ว',
    'app.siteNameShort': 'อ่างแก้ว',
    'app.subtitle': 'มหาวิทยาลัยเชียงใหม่',

    'user.guest': 'ผู้เยี่ยมชม',
    'user.role': 'ดูอย่างเดียว',
    'user.signOut': 'ออกจากระบบ',

    'status.good': 'ดี',
    'status.caution': 'เฝ้าระวัง',
    'status.danger': 'อันตราย',
    'status.unknown': 'ไม่ทราบ',
    'status.safe': 'ปลอดภัย',
    'status.online': 'ออนไลน์',
    'status.offline': 'ออฟไลน์',
    'status.noData': 'ไม่มีข้อมูล',

    'window.5m': '5 นาที',
    'window.15m': '15 นาที',
    'window.1h': '1 ชั่วโมง',
    'window.3h': '3 ชั่วโมง',
    'window.12h': '12 ชั่วโมง',
    'window.24h': '24 ชั่วโมง',
    'window.label': 'ช่วงเวลา',

    'param.temperature.label': 'อุณหภูมิ',
    'param.temperature.about':
      'อุณหภูมิน้ำกำหนดปริมาณออกซิเจนที่น้ำเก็บไว้ได้ และอัตราที่สิ่งมีชีวิตในน้ำใช้ออกซิเจนนั้น',
    'param.temperature.impact':
      'ค่าที่อยู่นอกช่วงปกติสร้างความเครียดให้ปลาและสิ่งมีชีวิตอื่นในน้ำ และอาจเร่งการเติบโตของสาหร่าย',
    'param.temperature.recommendation':
      'ตรวจสอบร่มเงา ทางน้ำเข้า และตำแหน่งของหัววัดว่าขยับหรือไม่ แล้วเฝ้าดูค่าอีกสองสามรอบก่อนดำเนินการ',

    'param.turbidity.label': 'ความขุ่น',
    'param.turbidity.about':
      'ความขุ่นคือปริมาณอนุภาคที่แขวนลอยอยู่ในน้ำ ซึ่งจำกัดระยะที่แสงส่องลงไปได้',
    'param.turbidity.impact':
      'ความขุ่นสูงบังแสงแดดไม่ให้ส่องถึงพืชน้ำ และมักบ่งชี้น้ำไหลบ่า ตะกอนที่ถูกกวน หรือการสะพรั่งของสาหร่าย',
    'param.turbidity.recommendation':
      'ตรวจสอบฝนที่ตกล่าสุดหรือการรบกวนทางต้นน้ำ หากค่ายังสูงอยู่ ให้ทำความสะอาดเลนส์เซนเซอร์',

    'param.tds.label': 'สารละลายทั้งหมด',
    'param.tds.about':
      'สารละลายทั้งหมด (TDS) คือปริมาณแร่ธาตุและเกลือที่ละลายอยู่ในน้ำ วัดเป็นส่วนในล้านส่วน',
    'param.tds.impact':
      'TDS ที่อยู่นอกช่วงปกติอาจเปลี่ยนรสชาติของน้ำ บ่งชี้การปนเปื้อน หรือสร้างความเครียดให้สิ่งมีชีวิตน้ำจืด',
    'param.tds.recommendation':
      'เปรียบเทียบกับแนวโน้มล่าสุด หากค่าสูงผิดปกติ ให้ตรวจสอบน้ำไหลบ่าหรือการระบายน้ำในบริเวณใกล้เคียง',

    'param.ec.label': 'การนำไฟฟ้า',
    'param.ec.about':
      'การนำไฟฟ้า (EC) เกิดจากไอออนที่ละลายอยู่ในน้ำ จึงแปรผันไปตาม TDS อย่างใกล้ชิด',
    'param.ec.impact':
      'ค่า EC ที่ผิดปกติหมายถึงเกลือหรือแร่ธาตุที่ละลายอยู่เปลี่ยนไป ซึ่งอาจบ่งชี้มลพิษหรือแร่ธาตุที่ไหลมากับน้ำ',
    'param.ec.recommendation':
      'ตรวจสอบค่า TDS ประกอบด้วย เพราะ EC คำนวณมาจากค่านั้น หากทั้งสองค่าเปลี่ยนกะทันหันควรตรวจสอบเพิ่มเติม',

    'detail.currentValue': 'ค่าปัจจุบัน',
    'detail.noRecord': 'ยังไม่มีข้อมูล',
    'detail.dataPoints': '{count} จุดข้อมูล',
    'detail.min': 'ต่ำสุด',
    'detail.avg': 'เฉลี่ย',
    'detail.max': 'สูงสุด',
    'detail.tooHigh': '{param} สูงกว่าช่วงปลอดภัย ({value} {unit})',
    'detail.tooLow': '{param} ต่ำกว่าช่วงปลอดภัย ({value} {unit})',
    'detail.checkSensor': 'ค่านี้ต่ำเกินกว่าจะเป็นจริง ควรตรวจสอบเซนเซอร์แทนที่จะตรวจคุณภาพน้ำ',
    'detail.normalRange': 'ช่วงปกติ: {range}',
    'detail.aboutTitle': 'เกี่ยวกับค่านี้',
    'detail.impactTitle': 'ผลกระทบ',
    'detail.recommendationTitle': 'ข้อแนะนำ',
    'detail.chartCaption': 'ข้อมูลจริงจากเซนเซอร์ เลือกช่วงเวลาได้ด้านบน',

    'wqi.title': 'ดัชนีคุณภาพน้ำ (WQI)',
    'wqi.moderate': 'ปานกลาง',
    'wqi.good': 'ดี',
    'wqi.empty': 'ยังไม่มีข้อมูลย้อนหลังในช่วงเวลานี้',
    'wqi.error': 'โหลดข้อมูลย้อนหลังของช่วงเวลานี้ไม่สำเร็จ',

    'calib.title': 'ปรับเทียบเซนเซอร์',
    'calib.subtitle': 'ปรับเทียบได้ขณะเซนเซอร์ทำงานอยู่ โดยไม่ต้องอัปโหลดเฟิร์มแวร์ใหม่',
    'calib.modeLabel': 'โหมดสอบเทียบ',
    'calib.modeOn': 'เปิด',
    'calib.modeOff': 'ปิด',
    'calib.applyingTurbidity': 'กำลังใช้ค่าสอบเทียบความขุ่น...',
    'calib.applyingTds': 'กำลังใช้ค่าสอบเทียบ TDS...',
    'calib.failedTurbidity': 'ใช้ค่าสอบเทียบความขุ่นไม่สำเร็จ',
    'calib.failedTds': 'ใช้ค่าสอบเทียบ TDS ไม่สำเร็จ',
    'calib.resetSuccess': 'รีเซ็ตค่าสอบเทียบแล้ว',
    'calib.resetFailed': 'รีเซ็ตไม่สำเร็จ',
    'calib.modeChangeFailed': 'เปลี่ยนโหมดไม่สำเร็จ',
    'calib.temperatureTitle': 'อุณหภูมิ',
    'calib.noCalibrationNeeded': 'ไม่ต้องสอบเทียบ',
    'calib.factoryCalibrated': 'ปรับเทียบจากโรงงานแล้ว (DS18B20 ±0.5°C)',
    'calib.ecTitle': 'การนำไฟฟ้า (EC)',
    'calib.noSeparateSensor': 'ไม่มีเซนเซอร์แยก',
    'calib.derivedFromTds': 'คำนวณจาก TDS (×0.5) สอบเทียบผ่าน TDS',
    'calib.resetTurbidity': 'รีเซ็ตความขุ่น',
    'calib.resetTds': 'รีเซ็ต TDS',
    'calib.observedRange': 'ค่าที่พบระหว่างสอบเทียบ: ต่ำสุด {min}, สูงสุด {max}',
    'calib.useMin': 'ใช้ค่าต่ำสุด',
    'calib.useMax': 'ใช้ค่าสูงสุด',
    'calib.resetRange': 'รีเซ็ตช่วงค่า',
    'calib.loading': 'กำลังโหลด...',
    'calib.sensorSelectAria': 'เลือกเซนเซอร์',
    'calib.turbidityFormTitle': 'สอบเทียบความขุ่น (2 จุด)',
    'calib.turbidityReferenceLabel': 'ค่ามาตรฐาน (NTU)',
    'calib.turbidityRawLabel': 'ค่าที่วัดได้ (Raw ADC)',
    'calib.turbidityRawHint': 'เว้นว่างเพื่อใช้ค่าปัจจุบัน',
    'calib.tdsFormTitle': 'สอบเทียบ TDS (k-factor)',
    'calib.tdsReferenceLabel': 'ค่ามาตรฐาน (ppm)',
    'calib.tdsRawLabel': 'ค่าที่วัดได้ (ppm, ไม่บังคับ)',
    'calib.tdsRawHint':
      'ใช้ดูตัวอย่างเท่านั้น ไม่ส่งไปเซิร์ฟเวอร์ กรอกค่า ppm ที่ยังไม่ได้ปรับเทียบ ไม่ใช่แรงดันไฟ',
    'calib.applyLabel': 'ใช้ค่า',
    'calib.applying': 'กำลังบันทึก...',
    'calib.needTwoPoints': 'ต้องการ 2 จุด',
    'calib.singlePoint': 'จุดเดียว',
    'calib.liveReading': 'ค่าปัจจุบัน',
    'calib.pointLabel': 'จุดที่ {n}',
    'calib.savedPoints': 'จุดที่บันทึกแล้ว',
    'calib.deletePoint': 'ลบจุด',
    'calib.coefficientsTitle': 'ค่าสัมประสิทธิ์',
    'calib.pending': 'ยังไม่ยืนยัน',
    'calib.notCalibrated': 'ยังไม่ได้สอบเทียบ',
    'calib.needTurbidityPoints': '2 จุด',
    'calib.needTdsPoints': '1 จุด',
    'calib.currentResult': 'ผลลัพธ์ปัจจุบัน',
    'calib.kFactorFormula': 'ppm ที่ปรับเทียบ = k × ค่า TDS ดิบ',
    'calib.lastSaved': 'บันทึกล่าสุด',

    'history.title': 'ประวัติข้อมูล',
    'history.loading': 'กำลังโหลด...',
    'history.failed': 'โหลดข้อมูลไม่สำเร็จ',
    'history.empty': 'ไม่มีข้อมูลในช่วงเวลานี้',
    'history.exportCsv': 'ส่งออก CSV',
    'history.col.time': 'เวลา',
    'history.col.temperature': 'อุณหภูมิ (°C)',
    'history.col.turbidity': 'ความขุ่น',
    'history.col.tds': 'สารละลายทั้งหมด (ppm)',
    'history.col.ec': 'การนำไฟฟ้า (µS/cm)',
    'history.col.status': 'สถานะ',
    'history.rowCount': '{count} รายการ จาก {source}',
    'history.refreshing': 'กำลังรีเฟรช...',

    'common.close': 'ปิด',
    'common.reload': 'โหลดใหม่',
    'common.error': 'เกิดข้อผิดพลาด',
    'common.openMenu': 'เปิดเมนู',
    'common.loading': 'กำลังโหลด...',
    'common.uncalibrated': 'ยังไม่สอบเทียบ (Raw ADC)',

    'theme.toggle': 'สลับธีม',
    'theme.light': 'สว่าง',
    'theme.dark': 'มืด',

    'lang.switch': 'เปลี่ยนภาษา',
    'lang.en': 'English',
    'lang.th': 'ไทย',
  } satisfies Record<keyof typeof en, string>,
} as const

export type MessageKey = keyof typeof messages.en
