import type { DB, User, Item } from '../types'
import * as L from './logic'

// Demo accounts — password เดียวกันหมด: 1234
const USERS: User[] = [
  { id: 'u-sales', email: 'sales@demo.co', password: '1234', fullName: 'สมชาย ฝ่ายขาย', department: 'sales', isActive: true },
  { id: 'u-project', email: 'project@demo.co', password: '1234', fullName: 'วิชัย ฝ่ายโครงการ', department: 'project', isActive: true },
  { id: 'u-purchasing', email: 'purchasing@demo.co', password: '1234', fullName: 'มาลี ฝ่ายจัดซื้อ', department: 'purchasing', isActive: true },
  { id: 'u-service', email: 'service@demo.co', password: '1234', fullName: 'ประสิทธิ์ ฝ่ายบริการ', department: 'service', isActive: true },
  { id: 'u-admin', email: 'admin@demo.co', password: '1234', fullName: 'ผู้ดูแลระบบ', department: 'admin', isActive: true },
]

const ITEMS: Item[] = [
  { id: 'i-lbs', code: 'LBS-115KV', name: '115kV Load Break Switch', itemType: 'main_equipment', uom: 'set', stockableCentrally: false },
  { id: 'i-ct', code: 'ACC-CT-01', epicorCode: 'EPC-CT-115', name: 'Current Transformer', itemType: 'accessory', uom: 'ชุด', stockableCentrally: true },
  { id: 'i-bracket', code: 'ACC-BRK-01', epicorCode: 'EPC-BRK-01', name: 'Mounting Bracket', itemType: 'accessory', uom: 'ชุด', stockableCentrally: true },
  { id: 'i-relay', code: 'ACC-RLY-01', epicorCode: 'EPC-RLY-7SR', name: 'Protection Relay', itemType: 'accessory', uom: 'ตัว', stockableCentrally: false },
  { id: 'i-cable', code: 'ACC-CBL-01', epicorCode: 'EPC-CBL-25', name: 'Control Cable 25m', itemType: 'accessory', uom: 'ม้วน', stockableCentrally: false },
]

// สร้างคู่ serial (LVB + OM) ต่อเครื่อง เช่น LBS24-001 / OM24-001
function units(prefix: string, from: number, count: number): { lvb: string; om: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(from + i).padStart(3, '0')
    return { lvb: `${prefix}-${n}`, om: `OM${prefix.slice(3)}-${n}` }
  })
}

export function buildSeedDb(): DB {
  let db: DB = {
    users: USERS,
    items: ITEMS,
    projectStocks: [], lbsUnits: [], jobs: [], allocations: [],
    accessoryStock: [
      { itemId: 'i-ct', qtyOnHand: 20 },
      { itemId: 'i-bracket', qtyOnHand: 15 },
    ],
    accessoryRequests: [], prs: [], pos: [], auditLogs: [], notifications: [],
  }

  const sales = USERS[0], project = USERS[1], purchasing = USERS[2]

  // Sales สั่ง LBS เข้าสต็อกกลาง 2 รอบ
  db = L.createProjectStock(db, sales, {
    stockNo: 'Project Stock No.1', itemId: 'i-lbs',
    units: units('LBS24', 1, 30), notes: 'ล็อตสั่งซื้อรอบที่ 1 (30 set)',
  })
  db = L.createProjectStock(db, sales, {
    stockNo: 'Project Stock No.2', itemId: 'i-lbs',
    units: units('LBS25', 1, 10), notes: 'ล็อตสั่งซื้อรอบที่ 2 (10 set)',
  })
  const stock1 = db.projectStocks[0].id
  const stock2 = db.projectStocks[1].id
  const unitsOf = (stockId: string) => db.lbsUnits.filter(u => u.projectStockId === stockId && u.status === 'in_stock')

  // JOB-0001: PEA เชียงใหม่ — ดึงแล้ว 3/4 → Allocated
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0001',
    customerName: 'PEA เชียงใหม่', scope: 'ติดตั้ง LBS สถานีย่อยสันทราย 4 จุด',
    installLocation: 'สถานีไฟฟ้าสันทราย จ.เชียงใหม่', requiredDate: '2026-08-20', lbsQtyRequired: 4,
    budgetSalePrice: 4800000, budgetCost: 3600000,
  })
  const job1 = db.jobs[0].id
  db = L.drawLbs(db, project, { jobId: job1, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 3).map(u => u.id) })

  // JOB-0002: กฟภ.ขอนแก่น — LBS ครบ แต่รอ Accessory จาก PO → Procuring Accessory
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0002',
    customerName: 'PEA ขอนแก่น', scope: 'เปลี่ยน LBS สายส่ง 115kV ช่วงบ้านไผ่ 5 จุด',
    installLocation: 'อ.บ้านไผ่ จ.ขอนแก่น', requiredDate: '2026-09-10', lbsQtyRequired: 5,
    budgetSalePrice: 6200000, budgetCost: 4700000,
  })
  const job2 = db.jobs[1].id
  db = L.drawLbs(db, project, { jobId: job2, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 3).map(u => u.id) })
  db = L.drawLbs(db, project, { jobId: job2, stockId: stock2, unitIds: unitsOf(stock2).slice(0, 2).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-ct', qty: 5, source: 'central_stock', unitPrice: 85000, phaseBudget: 'PH1-SUPPLY' })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-relay', qty: 5, source: 'purchasing', unitPrice: 120000, phaseBudget: 'PH1-SUPPLY' })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-cable', qty: 3, source: 'purchasing', unitPrice: 15000, phaseBudget: 'PH2-INSTALL' })
  db = L.createPR(db, project, { jobId: job2, requestIds: L.pendingPurchasingReqs(db, job2).map(r => r.id) })
  db = L.createPO(db, purchasing, { prId: db.prs[0].id, poNo: 'PO-2026-0001', supplierName: 'บจก.สยามอิเล็คทริค', expectedDate: '2026-07-30' })

  // JOB-0003: EGAT — ครบทุกอย่าง → Ready to Issue
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0003',
    customerName: 'EGAT บางปะกง', scope: 'ติดตั้ง LBS จุดเชื่อมโยงโรงไฟฟ้า 2 จุด',
    installLocation: 'โรงไฟฟ้าบางปะกง จ.ฉะเชิงเทรา', requiredDate: '2026-07-25', lbsQtyRequired: 2,
    budgetSalePrice: 2500000, budgetCost: 1900000,
  })
  const job3 = db.jobs[2].id
  db = L.drawLbs(db, project, { jobId: job3, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 2).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job3, itemId: 'i-bracket', qty: 2, source: 'central_stock', unitPrice: 32000 })

  // JOB-0004: อมตะซิตี้ — เบิกให้ Service แล้ว → Issued/Installed
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0004',
    customerName: 'นิคมอุตสาหกรรมอมตะซิตี้', scope: 'ติดตั้ง LBS วงจรสำรองโรงงาน 1 จุด',
    installLocation: 'อมตะซิตี้ จ.ระยอง', requiredDate: '2026-07-05', lbsQtyRequired: 1,
    budgetSalePrice: 1400000, budgetCost: 1050000,
  })
  const job4 = db.jobs[3].id
  db = L.drawLbs(db, project, { jobId: job4, stockId: stock2, unitIds: unitsOf(stock2).slice(0, 1).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job4, itemId: 'i-ct', qty: 1, source: 'central_stock', unitPrice: 85000 })
  db = L.issueJob(db, project, {
    jobId: job4, startDate: '2026-07-05', endDate: '2026-07-06',
    location: 'อมตะซิตี้ จ.ระยอง', note: 'ทีม Service A นัดติดตั้ง 5 ก.ค. 2026',
  })

  return db
}
