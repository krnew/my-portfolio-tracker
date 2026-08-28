# My Portfolio

เว็บพอร์ตส่วนตัว แทนที่ Portseido — Node server เปล่า (ไม่มี dependency ภายนอกเลย) + HTML/JS ธรรมดา ไม่มี framework ไม่มี build step Database คือไฟล์ `data/transactions.csv` ที่เปิดด้วย Excel ได้ตรงๆ

## หน้าจอ

### Home — ภาพรวมพอร์ต
![Home](docs/screenshots/home.jpg)

### Transactions — CRUD ธุรกรรม พร้อม ticker autocomplete และ Import CSV
![Transactions](docs/screenshots/transactions.jpg)

### Allocation — สัดส่วนการลงทุนแบบโดนัท
![Allocation](docs/screenshots/allocation.jpg)

### Performance — TWR/MWR เทียบ S&P500 พร้อมกราฟและตาราง Historical Return
![Performance](docs/screenshots/performance.jpg)

## ฟีเจอร์หลัก

- **Transactions**: เพิ่ม/แก้/ลบธุรกรรมได้ครบ, Import จาก CSV (map หัวคอลัมน์ยืดหยุ่น), Ticker พิมพ์แล้วค้นหาจริงจาก Yahoo Finance ให้อัตโนมัติ พร้อมรองรับทองคำดิจิทัลไทย (GOLD-THB) แยกแท็บกรอกเป็นกรัม/ยอดที่จ่าย
- **Home**: มูลค่าพอร์ต, กำไรวันนี้, Unrealized Gain, Realized P&L ดึงราคาสดจาก Yahoo Finance
- **Allocation**: สัดส่วนถือครองแบบโดนัท พร้อมตารางแยกตาม ticker
- **Performance**: Time-Weighted Return (TWR) และ Money-Weighted Return (XIRR) เทียบกับ "ถ้าลงทุน S&P500 แทน" มีกราฟ, ตาราง period return, heatmap รายเดือน/ไตรมาส/ปี
- **หลายสกุลเงิน**: แปลง THB→USD อัตโนมัติด้วยอัตราแลกเปลี่ยนย้อนหลังจริงของวันที่ทำธุรกรรม ไม่ใช่เรทวันนี้

## วิธีรัน

ดับเบิลคลิก `start.bat` → เปิด `http://127.0.0.1:8787/` อัตโนมัติ (ต้องมี [Node.js](https://nodejs.org/) ติดตั้งไว้ก่อน ไม่ต้องรัน `npm install` เพราะไม่มี dependency)

โปรเจกต์นี้เริ่มต้นด้วยพอร์ตเปล่า — ข้อมูลธุรกรรมจริง (`data/transactions.csv`) ถูก gitignore ไว้ ไม่ได้อยู่ใน repo นี้ ครั้งแรกที่รันจะเห็นพอร์ตว่างเปล่า พร้อมให้กด "+ Add Transaction" เพิ่มรายการแรกได้เลย

## เทคสแตก

Node.js `http` module ล้วนๆ (static file server + REST API, ไม่มี Express) ฝั่ง client เป็น vanilla JS แบบ IIFE namespace ต่อไฟล์ ไม่มี React/Vue ไม่มี bundler ราคาหุ้น/คริปโต/อัตราแลกเปลี่ยนดึงจาก Yahoo Finance และ frankfurter.dev ฝั่ง server (เลี่ยง CORS ไม่ต้องมี API key) ราคาทองคำไทยจาก [thai-gold-api](https://github.com/max180643/thai-gold-api)

รายละเอียดการพัฒนา, บั๊กที่เจอและแก้ไป, ข้อจำกัดที่รู้อยู่แล้ว — ดูที่ [PROGRESS.md](PROGRESS.md)
