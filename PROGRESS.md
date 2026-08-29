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
│   ├─ fx-history-cache.json  auto-generated: เรท USD→สกุลอื่นย้อนหลัง (จาก frankfurter.dev)
│   └─ news-cache.json     auto-generated: ข่าวต่อ ticker จาก Yahoo RSS (cache 6 ชม.)
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
        ├─ news.js         fetch wrapper เรียก /api/news (ข่าวต่อ ticker หน้า Home)
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
- `GET /api/news?tickers=...` — ข่าวต่อ ticker จาก Yahoo RSS feed (`feeds.finance.yahoo.com/rss/2.0/headline?s=...`) cache 6 ชม. โครง handler ก๊อป `/api/history` มาทั้งดุ้น (load cache ครั้งเดียว, fetch หลาย ticker พร้อมกัน, save ใต้ lock ครั้งเดียวตอนจบ) ticker ที่ไม่มีข่าว/ไม่มีจริง (รวมถึง `GOLD-THB`) ตอบ 200 + array ว่าง ไม่ error — ทดสอบยืนยันแล้วว่า Yahoo เองก็ตอบแบบนี้ ไม่ต้องดักเป็นพิเศษ
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
- **เลือก benchmark ได้เอง** (แทนที่ `'SPY'` hardcode ตัวเดียว) — หน้า Performance เพิ่มช่อง "เทียบกับ" ใช้ `TickerSuggest` ตัวเดียวกับ Add Transaction (เพิ่ม `opts.extraSuggestions` ให้พิมพ์ "nasdaq"/"s&p" แล้วเจอ `^NDX`/`^GSPC` โดยไม่ต้องรู้ syntax caret ของ Yahoo) เลือกพร้อมกันได้สูงสุด 4 ตัว เป็น chip ที่เอาออกได้ทีละตัว จำไว้ใน `localStorage` key `perf.benchmarks` (อ่าน/เขียนครอบ try/catch ทั้งคู่ เพราะโปรเจกต์นี้ไม่เคยแตะ browser storage มาก่อน — private mode/ปิด storage ต้องไม่ทำหน้าพัง) ค่าเริ่มต้นเมื่อไม่เคยตั้งอะไรไว้เลยคือ `['SPY']` เหมือนเดิม ส่วนเลือกจนเหลือ 0 ตัวเป็นสถานะที่ถูกต้อง (ดูพอร์ตเดี่ยวๆ)

  จุดที่ต้องคิดเยอะกว่าแค่เปลี่ยน `'SPY'` เป็นตัวแปร:
  1. **Calendar ต้องไม่ขึ้นกับ benchmark** — เดิม `buildCalendar` เอา SPY มา union วันทำการด้วย ถ้าเพิ่ม benchmark ที่วันทำการต่างจากพอร์ต (เช่น `^SET.BK` มีวันหยุดไทย, `BTC-USD` เทรดเสาร์อาทิตย์) ปฏิทินจะเปลี่ยน → TWR ของพอร์ตตัวเองจะขยับตามว่าเลือกเทียบกับอะไร ซึ่งผิด — แก้โดยแยก `computeCore()` ให้สร้าง calendar จาก ticker ในพอร์ตเท่านั้น แล้วให้ benchmark แต่ละตัว `forwardFill` ลงบน calendar นั้นทีหลังใน `loadBenchmarkData()`
  2. **แยก fetch/compute ของพอร์ต ออกจาก render** — เดิม `render()` ทำทุกอย่างรวดเดียวและรันครั้งเดียวตอนโหลดหน้า ถ้าเรียกซ้ำตอนเปลี่ยน benchmark จะผูก listener ของปุ่ม Monthly/Quarterly/Annually ซ้อนกันทุกครั้ง — แก้โดยแยกเป็น `computeCore()` (รันครั้งเดียว ไม่รู้จัก benchmark เลย) + `loadBenchmarkData()`/`ensureBenchmarkLoading()` (memoize ต่อ ticker ใน `benchmarkCache` — เอา chip ออกแล้วเพิ่มกลับไม่ fetch ซ้ำ) + `renderAll()` (เรียกซ้ำได้ตลอด ไม่ fetch/ไม่ผูก listener ใหม่) listener ทั้งหมดย้ายไปผูกที่ module scope ครั้งเดียวตอนโหลดสคริปต์
  3. **Benchmark สกุลอื่นต้องแปลงเป็น USD** — เอา currency จาก `/api/prices` (ราคาสด) ของ ticker นั้นมาตัดสินใจ แล้วเรียก `Currency.normalizeHistorySeries` แปลงราคาย้อนหลังทีละวันก่อนคำนวณผลตอบแทน (วิธีเดียวกับที่ GOLD-THB ทำอยู่แล้วใน `computeCore`) **หมายเหตุสำคัญ**: path ของ benchmark (`loadBenchmarkData`) แปลงสกุลเงินของราคาย้อนหลังได้ทั่วไปกว่า path ของ portfolio holdings เอง (`computeCore`) ตอนนี้ — ข้อจำกัด "ราคาย้อนหลังของหุ้นไทยผ่าน Yahoo" ด้านล่างยังคงอยู่เหมือนเดิมสำหรับ **holdings** (ไม่ได้แตะ `computeCore`) ถ้าจะเอา fix นี้ไปใช้กับ holdings ด้วยในอนาคต ดูโค้ดใน `loadBenchmarkData()` เป็นต้นแบบได้เลย

  เทียบพร้อมกันหลายตัว: กราฟ/legend/tooltip/ตาราง "แสดงเป็นตาราง" วาดเป็น N+1 เส้น, ตาราง Total Return เพิ่มทีละ 2 แถวต่อ benchmark (ตัวมันเอง + "vs" ตัวมันเอง), heatmap เพิ่มทีละ 2 คอลัมน์ต่อ benchmark — เลือกพอดี 1 ตัว (ค่าเริ่มต้น SPY) ได้หน้าตา/ตัวเลขเหมือนโค้ดเดิมทุกประการ (เทียบ regression แล้ว) ส่วน tile "vs Benchmark" อ้างอิงเฉพาะ chip ตัวแรกที่เลือกเท่านั้น (มีช่องเดียวโชว์)
- **ข่าวหุ้นที่ถือ ใน rail ขวาของหน้า Home** — ทดสอบเทียบแหล่งข้อมูล 2 ทางก่อนเลือก: Yahoo `/v1/finance/search?newsCount=` (endpoint เดียวกับที่ `/api/search` ใช้อยู่แล้ว) ให้ข่าวไม่ตรง ticker เท่าที่ควร (ทดสอบ `BTC-USD` ได้ข่าวท้องถิ่นโอไฮโอปนมา) ส่วน Yahoo RSS ต่อ ticker (`feeds.finance.yahoo.com/rss/2.0/headline?s=...`) ให้ข่าวตรงกว่ามาก จึงเลือกอันหลัง แม้ไม่มี thumbnail/publisher name ก็ตาม (ยืนยันแล้วว่า RSS ไม่มี `<source>`/`<dc:creator>` เลย — โชว์ ticker badge + เวลาแทนชื่อสำนักข่าว)

  จุดที่เจอระหว่างทำและวิธีแก้:
  1. **Entity ต้อง decode ฝั่ง server** — หัวข้อข่าวมี HTML entity จริง (`Procter &amp; Gamble`) ไม่มี CDATA แก้ด้วย `decodeXmlEntities()` regex ผ่านครั้งเดียว (ไม่ chain `.replace()` ต่อกัน เพราะ `&amp;lt;` จะโดน decode 2 ชั้นกลายเป็น `<` ได้) ฝั่ง client ยังต้อง `escapeHtml` ซ้ำตอน render ทุกจุด (title/badge/href) เหมือนเดิม
  2. **RSS item ไม่เรียงตามวันที่** — ทดสอบแล้วพบ pubDate สลับกันไปมาในฟีดเดียว (26,26,27,26,25,28,...) ต้อง sort เอง
  3. **ticker ที่เทรดถี่ (crypto 24/7) แย่งพื้นที่ตัวที่ถือมูลค่าเยอะกว่าได้** — เจอจริงตอนทดสอบ: พอร์ตถือ GOOGL (มูลค่ามากกว่า) กับ BTC-USD แต่ sort ตามเวลาอย่างเดียวทำให้ 10 อันดับแรกเป็น BTC-USD ล้วน (เพราะเทรดวันเสาร์-อาทิตย์ด้วย ข่าวออกถี่กว่าหุ้นที่ตลาดปิด) ทำให้ GOOGL หลุดจากรายการที่มองเห็น ทั้งที่เป็นโพซิชันใหญ่กว่า — แก้ด้วย **round-robin merge** (หมุนเอาข่าวใหม่สุดของแต่ละ ticker มาทีละ 1 ต่อรอบ แทนการ sort รวมทุก ticker แล้วตัด) การันตีว่าทุก ticker ที่ถือได้พื้นที่แสดงผลอย่างเป็นธรรม ไม่ขึ้นกับความถี่ข่าว
  4. **ticker มั่ว/pseudo-ticker (`GOLD-THB`) ไม่ error** — ยืนยันแล้วว่า Yahoo ตอบ 200 + 0 item เฉยๆ ไม่ throw จึงกรอง `GOLD-THB` ออกตั้งแต่ต้นทาง (รู้อยู่แล้วว่าไม่มีข่าว ประหยัด request เปล่า) ส่วน ticker อื่นที่ผิดจริงก็ปลอดภัยเพราะ endpoint คืน array ว่างเช่นกัน ไม่ทำให้ merge พัง
  5. **ข่าวต้องไม่ลาก Holdings table พังตาม** — `renderNews()` มี try/catch ของตัวเอง แยกจาก `render()` หลัก และเรียกแบบไม่ await (fire-and-forget) เพื่อไม่ให้หน่วงการ paint ตาราง — ทดสอบ mock ให้ fetch พังแล้วยืนยันว่าตารางยังขึ้นครบ
  6. **href ต้องกันสกีมอันตราย** — `escapeHtml` อย่างเดียวกัน `javascript:`/`data:` href ไม่ได้ (แค่กัน markup หลุด ไม่ได้กันสกีม) เพิ่ม `isSafeHttpUrl()` เช็คผ่าน `new URL()` อนุญาตแค่ `http:`/`https:` ก่อน แล้วค่อย escape ทับอีกชั้น ลิงก์ที่ไม่ผ่านเรนเดอร์เป็น `href="#"` + `aria-disabled` แทนที่จะเป็นลิงก์จริง

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
12. **ข่าวเก่าปนข่าวใหม่ใน news rail หน้า Home** — round-robin merge (ทำไว้กันตัว ticker ข่าวถี่แย่งพื้นที่ตัวข่าวเงียบ) แจกพื้นที่เท่ากันทุก ticker แต่ไม่เคยกรองอายุข่าวเลย พอร์ตทดสอบตอนแรกมีแต่ ticker ข่าวถี่ (GOOGL/MSFT/BTC-USD) จึงไม่เจอ — มาเจอตอนตอบคำถามว่าถือหุ้นไทยแล้วมีข่าวไหม: ทดสอบ Yahoo RSS กับ ticker `.BK` พบว่าบางตัวเก่าถึง ~9 เดือน (เทียบกับหุ้น US ที่~5 วัน) ถ้าไม่กรอง ข่าวเก่าจะไปแปะข้างข่าวเมื่อเช้าโดยไม่มีอะไรบอกว่าเก่า — แก้ด้วย `NEWS_MAX_AGE_DAYS = 30` กรองก่อน merge + เติมปีในป้ายวันที่เมื่อข่าวคนละปีกับปัจจุบัน (ไม่งั้น "5 พ.ย." ปีที่แล้วกับปีนี้แยกไม่ออก)

## จุดที่ยังไม่ทำ / ข้อจำกัดที่รู้อยู่แล้ว

- ไม่มี Sharpe Ratio (ต้องมี risk-free rate ที่ไม่มีแหล่งฟรีชัดเจน)
- ไม่มี breakdown ตาม Sector/Industry/Country (ไม่มีแหล่งข้อมูลฟรีที่เชื่อถือได้)
- ไม่มี automated test — ทดสอบด้วย script ชั่วคราวใน scratchpad ทุกรอบ (ไม่ได้ commit ไว้ในโปรเจกต์)
- แถว BTC-USD ในข้อมูลเดิมใช้ราคาประมาณจาก Avg Cost ที่ Portseido เคยคำนวณไว้ (ไม่ใช่ราคาซื้อจริงที่ยืนยันได้ 100%) — มี note กำกับไว้ในตาราง Transactions แล้ว
- V และ MSFT มีรายการขายที่ไม่มีรายการซื้อมาก่อนในเลดเจอร์นี้ (น่าจะซื้อไว้ก่อนเริ่มบันทึก) — ระบบ clamp ไม่ให้ shares ติดลบและมีแถบเตือนที่หน้า Home แล้ว แต่ตัวเลข avg cost/realized P&L ของสอง ticker นี้ไม่ครบ 100%
- **GOLD-THB**: ราคาอ้างอิงสมาคมค้าทองคำ ไม่ตรงกับราคาที่แอป GOLD NOW เสนอเป๊ะๆ (มี spread ของ Hua Seng Heng เองทับอีกชั้น) — ประวัติราคาก่อนวันที่เริ่มใช้ฟีเจอร์นี้ไม่มีจริง ใช้ราคาแรกที่สะสมได้ลากย้อนกลับไปแบนแทน (กราฟ Performance ช่วงก่อนวันเริ่ม track จึงไม่สะท้อนความผันผวนจริงของทองในช่วงนั้น)
- **สกุลเงินอื่นนอกจาก USD/THB**: `Currency.normalizeTransactions` (ledger) รองรับสกุลไหนก็ได้ที่ frankfurter.dev มีข้อมูล แต่ `Currency.normalizePrices` (ราคาสด) รองรับเฉพาะ THB เพราะ `/api/prices` คืน `fx` แค่คู่ USD/THB คู่เดียวตอนนี้
- **ราคาย้อนหลังของหุ้นไทยผ่าน Yahoo (เช่น PTT.BK)**: ราคาสดถูกแปลงเป็น USD อัตโนมัติแล้ว (ผลพลอยได้จาก `normalizePrices`) แต่ราคาย้อนหลังยังไม่ถูกแปลง เพราะ `/api/history` ของ Yahoo ยังไม่คืน currency มาด้วย (ทำเฉพาะ GOLD-THB ที่รู้ currency ตายตัว) — ถ้าจะซื้อหุ้นไทยจริงในอนาคต ต้องขยาย `fetchYahooHistory` ให้คืน currency มาด้วยก่อน
- **ไม่แปลหัวข้อข่าวเป็นไทย (ประเมินแล้ว ตัดสินใจไม่ทำ)** — แหล่งแปลที่ไม่ต้องใช้ API key เหลือรอดตัวเดียว: Google gtx (`translate.googleapis.com`) โดนบล็อก bot detection, Lingva 3 instance (`lingva.ml`/`plausibility.cloud`/`lunar.icu`) ตอบ HTTP 500 ทุกตัว (เป็น proxy ของ Google โดนบล็อกตามกัน), เหลือแต่ MyMemory (`api.mymemory.translated.net`) ที่ใช้ได้จริง (~1.2 วิ/หัวข้อ ไม่มี rate limit ในทางปฏิบัติ) แต่ทดสอบคุณภาพ EN→TH กับหัวข้อข่าวการเงินจริง 10 อันแล้วพบว่า ดี 5 · ศัพท์ผิดวงการ 3 (`catalyst`→"ตัวเร่งปฏิกิริยา" ที่ควรเป็น "ปัจจัยหนุน") · **ผิดจนความหมายกลับด้าน 2** (`sets precedent for`→"นำหน้า" ที่ถูกคือ "สร้างบรรทัดฐานให้", `Is Meta a buy?`→"Meta เป็นการซื้อ" สำนวนการเงินแปลตรงตัวจนเสียความหมาย) และบางครั้งแปลไม่หมด ปล่อยอังกฤษค้างกลางประโยค — เสี่ยงเกินไปสำหรับข้อมูลการเงินที่ต้องแม่น จึงคง rail เป็นภาษาอังกฤษไว้ ถ้าจะกลับมาทำอีกครั้ง โปรดรู้ไว้ก่อน: MyMemory ยัดข้อความ error ไว้ใน `responseData.translatedText` เอง (เช่น `"NO QUERY SPECIFIED..."` ถ้าอ่านตรงๆ จะได้ error ไปโชว์เป็นหัวข้อข่าว) และ `responseStatus` เป็น number `200` ตอนสำเร็จแต่เป็น **string** `"403"` ตอนพลาด ต้องเทียบด้วย `Number(...)` ไม่ใช่ `===` ตรงๆ
- **ข่าวหุ้นไทยและ ticker ที่ข่าวเงียบจะมีข่าวขึ้นน้อยหรือไม่มีเลยใน news rail** เพราะโดนกรองอายุ 30 วัน (ดูบั๊ก #12 ด้านบน) ถือว่าตั้งใจ — ดีกว่าโชว์ข่าวเก่าเป็นเดือนปนกับข่าววันนี้ ถ้าอยากได้ข่าวหุ้นไทย**ภาษาไทย**จริงๆ ในอนาคต: ทดสอบแล้วว่า Kaohoon RSS (`kaohoon.com/feed`) ใช้ได้ (HTTP 200, หัวข้อเกี่ยวหุ้นจริง) แต่เป็นฟีดข่าวตลาดรวม **ไม่ผูกกับ ticker** จึงเป็นคนละรูปแบบกับ rail ปัจจุบันที่ผูกกับพอร์ต ต้องออกแบบใหม่ ไม่ใช่แค่เพิ่มแหล่งข้อมูล (ลอง `thansettakij.com/rss/finance` ตอบ 301 และ `prachachat.net/finance/feed` ต่อไม่ติดด้วย)
