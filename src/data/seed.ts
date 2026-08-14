import type { DB, User, Item } from '../types'
import * as L from './logic'

// Demo accounts — password เดียวกันหมด: 1234
const USERS: User[] = [
  { id: 'u-sales', email: 'sales@demo.co', password: '1234', fullName: 'สมชาย ฝ่ายขาย', department: 'sales', isActive: true },
  { id: 'u-project', email: 'project@demo.co', password: '1234', fullName: 'วิชัย ฝ่ายโครงการ', department: 'project', isActive: true },
  { id: 'u-purchasing', email: 'purchasing@demo.co', password: '1234', fullName: 'มาลี ฝ่ายจัดซื้อ', department: 'purchasing', isActive: true },
  { id: 'u-service', email: 'service@demo.co', password: '1234', fullName: 'ประสิทธิ์ ฝ่ายบริการ', department: 'service', isActive: true },
  { id: 'u-admin', email: 'admin@demo.co', password: '1234', fullName: 'ผู้ดูแลระบบ', department: 'admin', isActive: true },
  { id: 'u-vip', email: 'vip@demo.co', password: '1234', fullName: 'ผู้บริหารสูงสุด', department: 'vip', isActive: true },
]

const ITEMS: Item[] = [
  { id: 'i-lbs', code: 'LBS-115KV', name: '115kV Load Break Switch', itemType: 'main_equipment', uom: 'set', stockableCentrally: false },
  { id: 'i-ct', code: 'ACC-CT-01', epicorCode: 'EPC-CT-115', name: 'Current Transformer', itemType: 'accessory', uom: 'ชุด', stockableCentrally: true },
  { id: 'i-bracket', code: 'ACC-BRK-01', epicorCode: 'EPC-BRK-01', name: 'Mounting Bracket', itemType: 'accessory', uom: 'ชุด', stockableCentrally: true },
  { id: 'i-relay', code: 'ACC-RLY-01', epicorCode: 'EPC-RLY-7SR', name: 'Protection Relay', itemType: 'accessory', uom: 'ตัว', stockableCentrally: false },
  { id: 'i-cable', code: 'ACC-CBL-01', epicorCode: 'EPC-CBL-25', name: 'Control Cable 25m', itemType: 'accessory', uom: 'ม้วน', stockableCentrally: false },
]

// สร้างคู่ serial (LVB + OM) ต่อเครื่อง เช่น LBS24-001 / OM24-001 · cost = ต้นทุนต่อเครื่อง (บาท)
function units(prefix: string, from: number, count: number, cost?: number): { lvb: string; om: string; cost?: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(from + i).padStart(3, '0')
    return { lvb: `${prefix}-${n}`, om: `OM${prefix.slice(3)}-${n}`, cost }
  })
}

export function buildSeedDb(): DB {
  let db: DB = {
    users: USERS,
    items: ITEMS,
    projectStocks: [], lbsUnits: [], jobs: [], allocations: [],
    // Lot No. (0055) — ตัวอย่างมีทั้งแบบระบุล็อตและไม่ระบุ ให้เห็นทั้ง 2 สถานะในตาราง
    accessoryStock: [
      { itemId: 'i-ct', qtyOnHand: 20, avgUnitCost: 80000, lotNo: 'LOT-CT-2026-01' },
      { itemId: 'i-bracket', qtyOnHand: 15, avgUnitCost: 4500 },
    ],
    // ยอดตั้งต้นต้องมีแถวใน ledger ด้วย ไม่งั้นประวัติการเคลื่อนไหวจะไม่เริ่มจากศูนย์ (S1/S2)
    stockMovements: [
      { id: 'sm-seed-ct', itemId: 'i-ct', qty: 20, unitCost: 80000, balanceAfter: 20,
        type: 'initial', note: 'ยอดตั้งต้นข้อมูลตัวอย่าง', performedBy: 'u-admin', performedAt: '2026-06-01T09:00:00.000Z' },
      { id: 'sm-seed-brk', itemId: 'i-bracket', qty: 15, unitCost: 4500, balanceAfter: 15,
        type: 'initial', note: 'ยอดตั้งต้นข้อมูลตัวอย่าง', performedBy: 'u-admin', performedAt: '2026-06-01T09:00:00.000Z' },
    ],
    accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [], auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
    teamMembers: [], jobAssignments: [], jobPayments: [],
    // Standard Drawing / BOM ตัวอย่าง (0045) — drawing ตัวที่ 2 ยังไม่แนบไฟล์ ให้เห็นสถานะนั้นด้วย
    stdDrawings: [
      { id: 's-dwg-1', title: 'Single Line Diagram — 115kV LBS Standard', drawingNo: 'STD-SLD-001',
        description: 'แบบมาตรฐานวงจรหลักของ LBS 115kV (ใช้อ้างอิงทุกโครงการ)',
        createdBy: 'u-admin', createdAt: '2026-06-10T02:00:00.000Z',
        updatedBy: 'u-admin', updatedAt: '2026-06-10T02:00:00.000Z' },
      { id: 's-dwg-2', title: 'Foundation & Structure Detail', drawingNo: 'STD-FDN-002',
        description: 'รายละเอียดฐานรากและโครงเหล็กรองรับ LBS',
        createdBy: 'u-admin', createdAt: '2026-06-12T02:00:00.000Z',
        updatedBy: 'u-admin', updatedAt: '2026-06-12T02:00:00.000Z' },
    ],
    // Standard Price list ตัวอย่าง (0054) — ตัวที่ 2 ยังไม่แนบไฟล์ ให้เห็นสถานะนั้นด้วย
    stdPrices: [
      { id: 's-prc-1', title: 'ราคามาตรฐาน 115kV LBS + อุปกรณ์ประกอบ ปี 2026', priceNo: 'STD-PRICE-2026-01',
        description: 'ราคาอ้างอิงสำหรับตั้งงบ Job และยื่นลูกค้า · มีผลถึงสิ้นปี 2026',
        createdBy: 'u-admin', createdAt: '2026-06-15T02:00:00.000Z',
        updatedBy: 'u-admin', updatedAt: '2026-06-15T02:00:00.000Z' },
      { id: 's-prc-2', title: 'ราคาค่าแรงติดตั้ง + ขนส่ง (Service Rate)', priceNo: 'STD-PRICE-2026-02',
        description: 'อัตราค่าแรงติดตั้งต่อเครื่องและค่าขนส่งตามระยะทาง',
        createdBy: 'u-admin', createdAt: '2026-06-18T02:00:00.000Z',
        updatedBy: 'u-admin', updatedAt: '2026-06-18T02:00:00.000Z' },
    ],
    stdBoms: [
      { id: 's-bom-1', title: 'BOM มาตรฐาน — ติดตั้ง LBS 1 ชุด (Outdoor)', bomNo: 'STD-BOM-001',
        description: 'รายการวัสดุมาตรฐานต่อการติดตั้ง LBS 1 เครื่อง',
        createdBy: 'u-admin', createdAt: '2026-06-10T02:00:00.000Z',
        updatedBy: 'u-admin', updatedAt: '2026-06-10T02:00:00.000Z' },
    ],
    stdBomLines: [
      { id: 's-bl-1', bomId: 's-bom-1', itemId: 'i-ct', epicorCode: 'EPC-CT-115',
        name: 'Current Transformer', qty: 3, uom: 'ชุด', estUnitCost: 80000 },
      { id: 's-bl-2', bomId: 's-bom-1', itemId: 'i-bracket', epicorCode: 'EPC-BRK-01',
        name: 'Mounting Bracket', qty: 4, uom: 'ชุด', estUnitCost: 4500 },
      { id: 's-bl-3', bomId: 's-bom-1', itemId: 'i-cable', epicorCode: 'EPC-CBL-25',
        name: 'Control Cable 25m', qty: 2, uom: 'ม้วน', estUnitCost: 12000,
        note: 'เผื่อความยาวตามระยะจริงหน้างาน' },
    ],
  }

  const sales = USERS[0], project = USERS[1], purchasing = USERS[2]

  // Sales สั่ง LBS เข้าสต็อกกลาง 2 รอบ
  db = L.createProjectStock(db, sales, {
    stockNo: 'Project Stock No.1', itemId: 'i-lbs',
    units: units('LBS24', 1, 30, 850000), notes: 'ล็อตสั่งซื้อรอบที่ 1 (30 set)', poNo: 'PO-2024-0011',
  })
  db = L.createProjectStock(db, sales, {
    stockNo: 'Project Stock No.2', itemId: 'i-lbs',
    units: units('LBS25', 1, 10, 890000), notes: 'ล็อตสั่งซื้อรอบที่ 2 (10 set)', poNo: 'PO-2025-0003',
  })
  // ล็อตรอบที่ 3 — เพิ่งลงเรือ (FOB = วันนี้ → ETA to WH อีก 60 วัน) ให้เห็นสถานะ "Pending" ในตาราง
  db = L.createProjectStock(db, sales, {
    stockNo: 'Project Stock No.3', itemId: 'i-lbs',
    units: units('LBS26', 1, 6, 920000), notes: 'ล็อตสั่งซื้อรอบที่ 3 (6 set) — ลงเรือแล้ว รอเข้าคลัง', poNo: 'PO-2026-0021',
  })
  db = L.setStockFob(db, sales, { stockId: db.projectStocks[2].id, fobDate: L.todayIso(), overwrite: true })

  const stock1 = db.projectStocks[0].id
  const stock2 = db.projectStocks[1].id
  const unitsOf = (stockId: string) => db.lbsUnits.filter(u => u.projectStockId === stockId && u.status === 'in_stock')

  // JOB-0001: PEA เชียงใหม่ — ดึงแล้ว 3/4 → Allocated
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0001',
    customerName: 'PEA เชียงใหม่', scope: 'ติดตั้ง LBS สถานีย่อยสันทราย 4 จุด',
    installLocation: 'สถานีไฟฟ้าสันทราย จ.เชียงใหม่', requiredDate: '2026-08-20', lbsQtyRequired: 4,
    installSites: [
      { location: 'สถานีไฟฟ้าแม่ริม จ.เชียงใหม่', requiredDate: '2026-08-22' },
      { location: 'สถานีไฟฟ้าสันกำแพง จ.เชียงใหม่', requiredDate: '2026-08-25' },
      { location: 'สถานีไฟฟ้าหางดง จ.เชียงใหม่', requiredDate: '2026-08-28' },
    ],
    budgetSalePrice: 4800000,
    budgetCosts: {
      raw_mat: { budget: 2200000, phase: 'PH1-MAT' }, outsourcing: { budget: 600000, phase: 'PH1-OUT' },
      trans: { budget: 200000, phase: 'PH2-TRN', actual: 0 }, eng: { budget: 300000, phase: 'PH2-ENG', actual: 0 },
      ove: { budget: 100000, phase: '', actual: 0 }, pm: { budget: 150000, phase: '', actual: 0 }, fin: { budget: 50000, phase: '', actual: 0 },
    },
  })
  const job1 = db.jobs[0].id
  db = L.drawLbs(db, project, { jobId: job1, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 3).map(u => u.id) })

  // JOB-0002: กฟภ.ขอนแก่น — LBS ครบ แต่รอ Accessory จาก PO → Procuring Accessory
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0002',
    customerName: 'PEA ขอนแก่น', scope: 'เปลี่ยน LBS สายส่ง 115kV ช่วงบ้านไผ่ 5 จุด',
    installLocation: 'อ.บ้านไผ่ จ.ขอนแก่น', requiredDate: '2026-09-10', lbsQtyRequired: 5,
    budgetSalePrice: 6200000,
    budgetCosts: {
      raw_mat: { budget: 3000000, phase: 'PH1-MAT' }, outsourcing: { budget: 800000, phase: 'PH1-OUT' },
      trans: { budget: 250000, phase: '', actual: 120000 }, eng: { budget: 350000, phase: '', actual: 200000 },
      ove: { budget: 120000, phase: '', actual: 0 }, pm: { budget: 130000, phase: '', actual: 0 }, fin: { budget: 50000, phase: '', actual: 0 },
    },
  })
  const job2 = db.jobs[1].id
  db = L.drawLbs(db, project, { jobId: job2, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 3).map(u => u.id) })
  db = L.drawLbs(db, project, { jobId: job2, stockId: stock2, unitIds: unitsOf(stock2).slice(0, 2).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-ct', qty: 5, source: 'central_stock', unitPrice: 85000, phaseBudget: 'raw_mat' })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-relay', qty: 5, source: 'purchasing', unitPrice: 120000, phaseBudget: 'raw_mat' })
  db = L.addAccessoryRequest(db, project, { jobId: job2, itemId: 'i-cable', qty: 3, source: 'purchasing', unitPrice: 15000, phaseBudget: 'outsourcing' })
  db = L.createPR(db, project, { jobId: job2, requestIds: L.pendingPurchasingReqs(db, job2).map(r => r.id) })
  db = L.createPO(db, purchasing, { prId: db.prs[0].id, poNo: 'PO-2026-0001', supplierName: 'บจก.สยามอิเล็คทริค', expectedDate: '2026-07-30' })

  // JOB-0003: EGAT — ครบทุกอย่าง → Ready to Issue
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0003',
    customerName: 'EGAT บางปะกง', scope: 'ติดตั้ง LBS จุดเชื่อมโยงโรงไฟฟ้า 2 จุด',
    installLocation: 'โรงไฟฟ้าบางปะกง จ.ฉะเชิงเทรา', requiredDate: '2026-07-25', lbsQtyRequired: 2,
    budgetSalePrice: 2500000,
    budgetCosts: {
      raw_mat: { budget: 1200000, phase: 'PH1-MAT' }, outsourcing: { budget: 300000, phase: '' },
      trans: { budget: 120000, phase: '', actual: 0 }, eng: { budget: 150000, phase: '', actual: 0 },
      ove: { budget: 60000, phase: '', actual: 0 }, pm: { budget: 50000, phase: '', actual: 0 }, fin: { budget: 20000, phase: '', actual: 0 },
    },
  })
  const job3 = db.jobs[2].id
  db = L.drawLbs(db, project, { jobId: job3, stockId: stock1, unitIds: unitsOf(stock1).slice(0, 2).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job3, itemId: 'i-bracket', qty: 2, source: 'central_stock', unitPrice: 32000, phaseBudget: 'raw_mat' })

  // JOB-0004: อมตะซิตี้ — เบิกให้ Service แล้ว → Issued/Installed
  db = L.createJob(db, project, {
    jobNo: 'JOB-2026-0004',
    customerName: 'นิคมอุตสาหกรรมอมตะซิตี้', scope: 'ติดตั้ง LBS วงจรสำรองโรงงาน 1 จุด',
    installLocation: 'อมตะซิตี้ จ.ระยอง', requiredDate: '2026-07-05', lbsQtyRequired: 1,
    budgetSalePrice: 1400000,
    budgetCosts: {
      raw_mat: { budget: 700000, phase: 'PH1-MAT' }, outsourcing: { budget: 150000, phase: '' },
      trans: { budget: 60000, phase: '', actual: 55000 }, eng: { budget: 80000, phase: '', actual: 70000 },
      ove: { budget: 30000, phase: '', actual: 0 }, pm: { budget: 20000, phase: '', actual: 0 }, fin: { budget: 10000, phase: '', actual: 0 },
    },
  })
  const job4 = db.jobs[3].id
  db = L.drawLbs(db, project, { jobId: job4, stockId: stock2, unitIds: unitsOf(stock2).slice(0, 1).map(u => u.id) })
  db = L.addAccessoryRequest(db, project, { jobId: job4, itemId: 'i-ct', qty: 1, source: 'central_stock', unitPrice: 85000, phaseBudget: 'raw_mat' })
  db = L.issueJob(db, project, {
    jobId: job4, startDate: '2026-07-05', endDate: '2026-07-06',
    location: 'อมตะซิตี้ จ.ระยอง', note: 'ทีม Service A นัดติดตั้ง 5 ก.ค. 2026',
  })

  return db
}
