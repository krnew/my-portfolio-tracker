# My Portfolio — Progress Log

เว็บพอร์ตส่วนตัว แทนที่ Portseido — Node server เปล่า (ไม่มี dependency) + HTML/JS ธรรมดา ไม่มี framework ไม่มี build step Database คือไฟล์ `data/transactions.csv` ที่เปิดด้วย Excel ได้ตรงๆ

## วิธีรัน

ดับเบิลคลิก `start.bat` → เปิด `http://127.0.0.1:8787/` อัตโนมัติ (ถ้าเซิร์ฟเวอร์เปิดอยู่แล้วจะขึ้นข้อความบอกเฉยๆ ไม่ error)

## โครงสร้างไฟล์

```
V:\cloneweb\
├─ start.bat              ดับเบิลคลิกอันนี้
├─ server.js               Node เปล่า: static file server + REST API
├─ data\
│   ├─ transactions.csv    ← database จริง แก้ด้วย Excel ได้
│   ├─ prices-cache.json   auto-generated, ลบทิ้งได้ถ้าอยากบังคับดึงราคาใหม่
│   ├─ history-cache.json  auto-generated เช่นกัน
│   ├─ gold-thb-history.json  auto-generated: ราคาทอง GOLD-THB สะสมทีละวัน (Thai Gold API มีแค่ latest)
│   └─ fx-history-cache.json  auto-generated: เรท USD→สกุลอื่นย้อนหลัง (จาก frankfurter.dev)
└─ public\
    ├─ index.html          หน้า Home
    ├─ transactions.html   หน้า Transactions (CRUD + Import CSV)
    ├─ allocation.html     หน้า Allocation (โดนัท)
    ├─ performance.html    หน้า Performance (TWR/MWR/กราฟ)
    ├─ css/style.css
    └─ js/
        ├─ csv.js          CSV parser (ใช้ฝั่ง client สำหรับ import)
        ├─ api.js          fetch wrapper เรียก REST API
        ├─ format.js       fmtMoney/fmtPct/escapeHtml/todayLocalISO/setTile (shared)
        ├─ ticker-suggest.js  autocomplete ช่อง Ticker (ledger + /api/search + synthetic list ผสมกัน)
        ├─ currency.js     แปลง THB→USD ทุกจุดในระบบ (ledger/ราคาสด/ราคาย้อนหลัง) - ดูหัวข้อด้านล่าง
        ├─ holdings.js     คำนวณ shares/avgCost/realizedPL จาก ledger
        ├─ prices.js       fetch wrapper เรียก /api/prices
        ├─ portfolio.js    รวม holdings + ราคาสด → market value/unrealized gain
        ├─ timeseries.js   TWR/XIRR/benchmark simulation (คณิตศาสตร์การเงิน)
        ├─ home.js / allocation.js / performance.js  = โค้ดต่อหน้า (ใช้ currency.js)
        ├─ transactions.js  = โค้ดหน้า Transactions (ไม่ใช้ currency.js - โชว์ค่าดิบเสมอ)
```

## Endpoint ฝั่ง server (`server.js`)

- `GET/POST /api/transactions`, `PUT/DELETE /api/transactions/:id`, `POST /api/transactions/bulk` — CRUD บน CSV
- `GET /api/prices?tickers=...` — ราคาปัจจุบันจาก Yahoo Finance (cache 5 นาที) + อัตราแลกเปลี่ยน USD→THB จาก frankfurter.dev (cache 1 ชม.)
- `GET /api/history?tickers=...&start=...` — ราคาปิดรายวันย้อนหลังจาก Yahoo Finance (cache 12 ชม.)
- `GET /api/search?q=...` — autocomplete ช่อง Ticker: proxy ไป Yahoo symbol search, กรองเอาเฉพาะ EQUITY/ETF/MUTUALFUND/CRYPTOCURRENCY/INDEX (Yahoo เอา option contract ปนมาด้วยถ้าไม่กรอง เช่น ค้นหา "goog" จะเจอ `GOOGL261218C00345000`), cache ใน memory ล้วนๆ 10 นาที (ไม่ลงดิสก์ เพราะเป็นแค่คำแนะนำชั่วคราว ไม่ใช่ข้อมูลพอร์ต จึงไม่ต้องใช้ write lock เหมือน prices/history cache) ล่มแล้วตอบ 200 + results ว่างเสมอ ไม่ใช่ error เพื่อไม่ให้บล็อกการพิมพ์
- `GET /api/fx-history?currency=...&start=...` — เรท USD→สกุลอื่นย้อนหลัง จาก frankfurter.dev (มี historical range endpoint จริง, cache 12 ชม. เหมือน history cache)
- ดึงราคาจาก**ฝั่ง server** ทำให้ไม่ติด CORS และไม่ต้องมี API key เลย (ค้นพบระหว่างทำ ตอนแรกคิดว่าต้องสมัคร Twelve Data)

## GOLD-THB + รองรับหลายสกุลเงิน (เพิ่มทีหลัง)

ticker พิเศษ `GOLD-THB` (หน่วย: **กรัม**) แทนทองคำดิจิทัลจากแอป GOLD NOW ของ Hua Seng Heng ราคาอ้างอิงสมาคมค้าทองคำผ่าน `api.chnwt.dev/thai-gold-api` (โอเพนซอร์สคนเดียวดูแล, มีแค่ `/latest` ไม่มีย้อนหลัง — server สะสมเองทีละวันลง `data/gold-thb-history.json`)

**พบว่า `holdings.js`/`portfolio.js` ไม่เคยใช้ field `currency` ในการคำนวณเลยมาก่อน** (4 ticker เดิมล้วน USD) ถ้าใส่ GOLD-THB ตรงๆ ยอดพอร์ตจะพองผิด ~30 เท่า จึงเพิ่มไฟล์ `public/js/currency.js` เป็นจุดเดียวในระบบที่แปลงสกุลเงิน:
- ledger (`data/transactions.csv`) เก็บค่าดิบ (THB) เสมอ ไม่แตะ — หน้า Transactions ไม่รู้จัก currency.js เลย
- Home/Allocation/Performance ดึง transactions มาแปลงเป็น USD ด้วย **historical FX rate ของวันที่ทำธุรกรรมจริง** (ไม่ใช่เรทวันนี้) ก่อนส่งเข้า Holdings/TimeSeries ที่มีอยู่แล้ว
- server.js ไม่เคยทำคำนวณการเงินเลย (fetch + cache ค่าดิบเท่านั้น) — สไตล์เดิมของไฟล์รักษาไว้ครบ

**บั๊กที่เจอระหว่างทำ (สำคัญ)**: ตอนแรก `Currency.normalizeHistorySeries` แปลงแต่ละจุดในซีรีส์ราคาทอง (ซึ่ง sparse แค่ 2 จุด: วันแรกที่ต้องใช้ข้อมูล + วันนี้) ด้วยเรทของวันนั้นๆ ก่อน แล้วค่อยปล่อยให้ `TimeSeries.forwardFill` (generic, ไม่รู้จัก currency) ลากค่า USD ที่แปลงเสร็จแล้วยาวไปทั้งช่วง —ผลคือค่า USD ทั้งช่วงหลายเดือนแข็งอยู่ที่เรทของวันแรกวันเดียว พอมีธุรกรรมจริงตกอยู่กลางช่วง (cash flow ใช้เรทของวันนั้นเป๊ะ) ตัวเลขสองทางไม่ตรงกัน กลายเป็น TWR รายวันของวันนั้นพุ่งผิดปกติ (ทดสอบจริงเจอ +20.4% ในวันเดียว ทั้งที่ควรจะเป็น ~1%) แก้โดยสลับลำดับ: forward-fill ราคาดิบ (สกุลเงินเดิม) ให้ครบทุกวันที่มีเรท FX ก่อน แล้วค่อยแปลงแต่ละวันด้วยเรทของวันนั้นทีหลัง

## ลำดับที่ทำ

**เฟส 1 — แกนหลัก**: Transactions (CRUD, import CSV พร้อม map หัวคอลัมน์ยืดหยุ่น), Home (holdings summary จาก ledger อย่างเดียว ยังไม่มีราคาสด), seed ข้อมูลจริง 9 รายการจาก Portseido ของผู้ใช้

**เฟส 2 — ราคาจริง**: Home มี Portfolio Value/Today/Unrealized Gain, หน้า Allocation ใหม่ (ตอนแรกเป็น stacked bar ตาม dataviz skill แนะนำ)

**เฟส 3 — Performance**: TWR (Time-Weighted Return) และ MWR/XIRR คำนวณเอง ทดสอบเทียบเคสที่รู้คำตอบล่วงหน้าก่อนขึ้นจริง, กราฟมูลค่าพอร์ตเทียบ "ถ้าลงทุน S&P500 แทน" พร้อม hover tooltip, ตาราง Total Return แยกตามช่วงเวลา, heatmap Monthly/Quarterly/Annually

**เพิ่มทีหลัง**:
- ปุ่มเลือกช่วงเวลาบนกราฟ Performance (1M/3M/6M/YTD/1Y/3Y/5Y/All)
- เปลี่ยน Allocation จาก stacked bar เป็นโดนัท (SVG, มี leader-line label แบบ Portseido)
- หน้า Transactions: การ์ดตารางสูงเท่าหน้าต่าง (`body.page-transactions`, ไม่กระทบ 3 หน้าอื่นที่ใช้ `.card`/`.table-scroll` ร่วมกัน) ตัวตารางเลื่อนในตัวเองพร้อมหัวตาราง sticky แทนที่จะเลื่อนทั้งหน้า — แก้ปัญหาที่ note ยาว (แถว BTC-USD) เคยดันตารางกว้างจนปุ่ม edit/delete หลุดจอ (นี่คืออาการเดียวกับบั๊กข้อ 1 ด้านล่าง คนละสาเหตุ)
- ช่อง Ticker autocomplete (`ticker-suggest.js`): ticker ที่มีอยู่แล้วในเลดเจอร์ขึ้นทันที + ผลค้นหาออนไลน์จาก `/api/search` แบบ debounce ผสมกัน มี keyboard nav, กัน response เก่ามาทับใหม่ด้วย sequence number, ยังพิมพ์เองอิสระได้เสมอแม้เน็ต/Yahoo ล่ม
- ฟอร์ม Add/Edit Transaction: คำอธิบายไทยใต้ทุกช่อง + แยกเป็น 2 แท็บ **"หุ้น/คริปโต"** กับ **"ทองไทย (GOLD-THB)"** (`.pill-toggle` ที่มีอยู่แล้ว) เพราะฟอร์มเดียวรวมกันแล้วสับสน (ผู้ใช้บอกว่า "งงมากๆ") — แท็บทองซ่อน Ticker/Currency ไปเลย (auto = GOLD-THB/THB) เหลือแค่ "จำนวนกรัม" + "ยอดรวมที่จ่าย (บาท)" คำนวณราคา/กรัมให้ดูเป็นข้อมูลอ้างอิง พร้อมโชว์ราคาทองปัจจุบันจาก `/api/prices` ช่วยเทียบ ส่วนแท็บหุ้นมี Ticker autocomplete + ช่อง "ยอดรวมที่จ่าย" (คำนวณ Price จากยอดรวม÷shares) + ปุ่ม "ดึงราคาปิดของวันที่เลือก" (ใช้ `/api/history` ถอยไปวันทำการก่อนหน้าอัตโนมัติถ้าตรงวันหยุด) — สลับแท็บแล้ว sync ค่าเข้า field ภายใน (`f-ticker`/`f-price`/`f-currency`/`f-shares`) ให้เอง ตัว submit handler/schema/CSV **ไม่เปลี่ยนเลย** ทุกอย่างเป็น UI ล้วนๆ
  - บั๊กที่ต้องระวังตอนทำ: field ที่ถูกซ่อนด้วย `display:none` ตอนอยู่คนละแท็บ **ห้ามมี `required`** เพราะ browser จะ throw "not focusable" แทนที่จะ submit ได้ตามปกติ — ย้าย validation ของ `f-ticker`/`f-shares` ไปเช็คเองใน submit handler แทน
- `validateInput`: Buy/Sell บังคับต้องมี price (>0) แล้ว กันเคสลืมกรอกราคาแล้ว cost basis เป็น 0 (Transfer in/out ยังปล่อยว่างได้ปกติ)
- `.overlay`/`.modal`: เปลี่ยนจาก `align-items:center` ไม่มี scroll เป็น `align-items:flex-start` + scroll ที่ `.overlay` (ไม่ใช่ `.modal` — สำคัญ เพราะ `.suggest-panel` ของ ticker autocomplete ต้องลอยล้นออกนอก `.modal` ได้ ถ้า `.modal` มี overflow ดรอปดาวน์จะโดนตัด) กันฟอร์มที่สูงขึ้นจากคำอธิบาย+ช่องใหม่ล้นจอแล้วกดปุ่ม Save ไม่ถึงบนจอเตี้ย

## บั๊กที่เจอและแก้ระหว่างทาง (สำคัญ ควรรู้ไว้)

1. **CSS `overflow:hidden`** บนตาราง Transactions ทำให้ปุ่ม edit/delete หายไปเลย (ไม่ใช่แค่ scroll ไม่ถึง) — แก้เป็น scroll container
2. **Unrealized Gain รวมคำนวณผิด** เมื่อมี ticker ที่ดึงราคาไม่ได้ — เอา cost basis ไปหักออกจากยอดรวมทั้งที่ market value ไม่ถูกนับด้วย
3. **TWR เพี้ยนเป็น +701%** — `buildSharesTimeline` ไม่ clamp การขายเกินจำนวนที่ถือ (ต่างจาก `Holdings.compute` ที่ทำถูก) ทำให้เกิด "short position ผี" ไปหักมูลค่าพอร์ตย้อนหลังทั้งหมด แก้แล้วให้ clamp เหมือนกัน
4. **Cache race condition** 2 ระดับ: (ก) ภายใน 1 request ที่ดึงหลาย ticker พร้อมกัน แต่ละตัวเขียนทับกันเอง (ข) ข้าม request ที่ยิงพร้อมกัน — แก้ด้วยการรวม load/save ไว้จุดเดียว + เพิ่ม write lock
5. **XSS** ในหน้า Home — ไม่ได้ escape ticker ก่อนใส่ลง innerHTML
6. **วันที่มั่ว/อนาคตผ่าน validation ได้** — เพิ่ม regex + reject วันที่เกินวันนี้ (ใช้ local date ไม่ใช่ UTC เพราะ UTC จะช้ากว่าเวลาไทย 7 ชม.)
7. **Import CSV ซ้ำไม่เตือน** — เพิ่ม checkbox preview ก่อน confirm import พร้อม flag รายการที่ซ้ำกับของเดิม
8. **เปิด start.bat ซ้ำแล้ว error หน้าตาน่ากลัว** (EADDRINUSE) — ดักแล้วขึ้นข้อความปกติแทน
9. **Chart hover เพี้ยนหลัง resize หน้าต่าง** — ไม่ได้คำนวณ scale ระหว่างพิกัดหน้าจอกับ viewBox ของ SVG
10. **CSS align ตัวเลขในตาราง period-return ไม่ตรงกับหัวตาราง** — selector เขียนผิด (`.dash` ไม่มีจริง)
11. **TWR พุ่งผิดปกติวันเดียววันที่มีธุรกรรมสกุลเงินอื่น (THB)** — แปลงราคาย้อนหลัง (sparse) เป็น USD ทีละจุดก่อน แล้วค่อย forward-fill ทำให้ค่า USD แข็งอยู่ที่เรทวันเดียวยาวทั้งช่วง ไม่ตรงกับ cash flow ที่ใช้เรทวันจริง — แก้โดย forward-fill ราคาดิบก่อน แล้วแปลงทีหลังทีละวัน (ดูหัวข้อ GOLD-THB ด้านล่าง)

## จุดที่ยังไม่ทำ / ข้อจำกัดที่รู้อยู่แล้ว

- ไม่มี Sharpe Ratio (ต้องมี risk-free rate ที่ไม่มีแหล่งฟรีชัดเจน)
- ไม่มี breakdown ตาม Sector/Industry/Country (ไม่มีแหล่งข้อมูลฟรีที่เชื่อถือได้)
- ไม่มี automated test — ทดสอบด้วย script ชั่วคราวใน scratchpad ทุกรอบ (ไม่ได้ commit ไว้ในโปรเจกต์)
- แถว BTC-USD ในข้อมูลเดิมใช้ราคาประมาณจาก Avg Cost ที่ Portseido เคยคำนวณไว้ (ไม่ใช่ราคาซื้อจริงที่ยืนยันได้ 100%) — มี note กำกับไว้ในตาราง Transactions แล้ว
- V และ MSFT มีรายการขายที่ไม่มีรายการซื้อมาก่อนในเลดเจอร์นี้ (น่าจะซื้อไว้ก่อนเริ่มบันทึก) — ระบบ clamp ไม่ให้ shares ติดลบและมีแถบเตือนที่หน้า Home แล้ว แต่ตัวเลข avg cost/realized P&L ของสอง ticker นี้ไม่ครบ 100%
- **GOLD-THB**: ราคาอ้างอิงสมาคมค้าทองคำ ไม่ตรงกับราคาที่แอป GOLD NOW เสนอเป๊ะๆ (มี spread ของ Hua Seng Heng เองทับอีกชั้น) — ประวัติราคาก่อนวันที่เริ่มใช้ฟีเจอร์นี้ไม่มีจริง ใช้ราคาแรกที่สะสมได้ลากย้อนกลับไปแบนแทน (กราฟ Performance ช่วงก่อนวันเริ่ม track จึงไม่สะท้อนความผันผวนจริงของทองในช่วงนั้น)
- **สกุลเงินอื่นนอกจาก USD/THB**: `Currency.normalizeTransactions` (ledger) รองรับสกุลไหนก็ได้ที่ frankfurter.dev มีข้อมูล แต่ `Currency.normalizePrices` (ราคาสด) รองรับเฉพาะ THB เพราะ `/api/prices` คืน `fx` แค่คู่ USD/THB คู่เดียวตอนนี้
- **ราคาย้อนหลังของหุ้นไทยผ่าน Yahoo (เช่น PTT.BK)**: ราคาสดถูกแปลงเป็น USD อัตโนมัติแล้ว (ผลพลอยได้จาก `normalizePrices`) แต่ราคาย้อนหลังยังไม่ถูกแปลง เพราะ `/api/history` ของ Yahoo ยังไม่คืน currency มาด้วย (ทำเฉพาะ GOLD-THB ที่รู้ currency ตายตัว) — ถ้าจะซื้อหุ้นไทยจริงในอนาคต ต้องขยาย `fetchYahooHistory` ให้คืน currency มาด้วยก่อน
