const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');

function loadEnv(file = path.join(__dirname, '.env')) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

loadEnv();

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TMT_STEEL_SPECIFICATIONS = ['8 mm', '10 mm', '12 mm', '16 mm', '20 mm', '25 mm', '32 mm'];
function normalizeProductRow(row){
  if(!row) return row;
  return {...row, specifications: ensureTmtSteelSpecifications(row.name,row.specifications||'')};
}
function ensureTmtSteelSpecifications(name, specifications){
  if(String(name||'').trim().toLowerCase()==='tmt steel') return TMT_STEEL_SPECIFICATIONS.join('\n');
  return specifications;
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_RECOVERY_EMAIL = process.env.ADMIN_RECOVERY_EMAIL || '';
const ADMIN_RECOVERY_EMAIL_2 = process.env.ADMIN_RECOVERY_EMAIL_2 || '';
const SECRET = process.env.SESSION_SECRET || '';
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!SECRET) {
  console.error('Missing SESSION_SECRET.');
  process.exit(1);
}
if (!ADMIN_PASSWORD && !ADMIN_EMAIL) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env for the initial admin account.');
  process.exit(1);
}

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.');
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});

const sessions = new Set();
const recoverySessions = new Set();


async function tableColumns(table) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(r.rows.map(row => String(row.name)));
}
async function ensureColumn(table, column, definition) {
  const columns = await tableColumns(table);
  if (!columns.has(column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
async function ensureAdminAccount() {
  await db.execute(`CREATE TABLE IF NOT EXISTS admin_accounts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
    recovery_email_1 TEXT NOT NULL DEFAULT '',recovery_email_2 TEXT NOT NULL DEFAULT '',
    reset_token_hash TEXT NOT NULL DEFAULT '',reset_expires_at TEXT NOT NULL DEFAULT '',
    otp_challenge_hash TEXT NOT NULL DEFAULT '',otp_code_hash TEXT NOT NULL DEFAULT '',
    otp_expires_at TEXT NOT NULL DEFAULT '',otp_purpose TEXT NOT NULL DEFAULT '',
    otp_attempts INTEGER NOT NULL DEFAULT 0,otp_last_sent_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const existing=await db.execute('SELECT id FROM admin_accounts ORDER BY id LIMIT 1');
  if(!existing.rows.length){
    if(!ADMIN_EMAIL||!ADMIN_PASSWORD) throw new Error('Initial admin account requires ADMIN_EMAIL and ADMIN_PASSWORD');
    await db.execute({sql:`INSERT INTO admin_accounts(email,password_hash,recovery_email_1,recovery_email_2) VALUES(?,?,?,?)`,
      args:[ADMIN_EMAIL.trim().toLowerCase(),await bcrypt.hash(ADMIN_PASSWORD,12),ADMIN_RECOVERY_EMAIL.trim().toLowerCase(),ADMIN_RECOVERY_EMAIL_2.trim().toLowerCase()]});
  }else{
    await db.execute({sql:`UPDATE admin_accounts SET email=COALESCE(NULLIF(?,''),email),
      recovery_email_1=COALESCE(NULLIF(?,''),recovery_email_1),
      recovery_email_2=COALESCE(NULLIF(?,''),recovery_email_2),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args:[ADMIN_EMAIL.trim().toLowerCase(),ADMIN_RECOVERY_EMAIL.trim().toLowerCase(),ADMIN_RECOVERY_EMAIL_2.trim().toLowerCase(),Number(existing.rows[0].id)]});
  }
}
function normalizeName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
async function resolveLegacyBrandProductIds(){
  const products=await db.execute('SELECT id,name,category FROM products ORDER BY sort_order,id');
  const byName=new Map(),byCategory=new Map();
  for(const p of products.rows){byName.set(normalizeName(p.name),Number(p.id));byCategory.set(normalizeName(p.category),Number(p.id));}
  const brands=await db.execute('SELECT id,category FROM brands WHERE product_id IS NULL OR product_id=0');
  const rules=[
    [['tmt bars','tmt steel'],['tmt steel','tmt bars']],
    [['cement'],['cement']],
    [['roofing solution','roofing sheets','roofing'],['roofing sheets']],
    [['bricks','masonry'],['bricks']],
    [['pipes','pipes steel products'],['pipes steel products','round pipes','square pipes']],
    [['structurals','structural steel'],['structural steel']]
  ];
  for(const b of brands.rows){
    const c=normalizeName(b.category); let productId=byName.get(c)||byCategory.get(c);
    if(!productId) for(const [needles,names] of rules){
      if(needles.some(n=>c.includes(n))){for(const n of names){if(byName.has(n)){productId=byName.get(n);break;}}}
      if(productId)break;
    }
    if(productId) await db.execute({sql:'UPDATE brands SET product_id=? WHERE id=?',args:[productId,Number(b.id)]});
  }
}
function parseCookies(req){
  const out={}; for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>-1)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1));} return out;
}
async function readRaw(req,limit=8*1024*1024){
  return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>limit){req.destroy();reject(new Error('Request too large'));return;}chunks.push(c);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
}
function parseMultipart(buffer,contentType){
  const match=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType||''); if(!match)throw new Error('Missing multipart boundary');
  const boundary=Buffer.from('--'+(match[1]||match[2])),fields={},files=[];let start=0;
  while(true){const idx=buffer.indexOf(boundary,start);if(idx===-1)break;let ps=idx+boundary.length;if(buffer.slice(ps,ps+2).toString()==='--')break;if(buffer.slice(ps,ps+2).toString()==='\r\n')ps+=2;
    const he=buffer.indexOf(Buffer.from('\r\n\r\n'),ps);if(he===-1)break;const headers=buffer.slice(ps,he).toString('utf8');const ds=he+4;const nb=buffer.indexOf(boundary,ds);if(nb===-1)break;let de=nb;if(buffer.slice(de-2,de).toString()==='\r\n')de-=2;
    const disp=/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);const type=/Content-Type:\s*([^\r\n]+)/i.exec(headers);
    if(disp){if(disp[2]!==undefined&&disp[2]!=='')files.push({field:disp[1],filename:path.basename(disp[2]),contentType:type?type[1].trim().toLowerCase():'application/octet-stream',data:buffer.slice(ds,de)});else fields[disp[1]]=buffer.slice(ds,de).toString('utf8');}start=nb;}
  return {fields,files};
}
function safeFilename(name){return String(name||'upload').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')||'upload';}
async function saveUploadedImage(file,folder,prefix){
  if(!file)return '';

  const allowed=new Map([
    ['image/jpeg','.jpg'],
    ['image/png','.png'],
    ['image/webp','.webp'],
    ['image/gif','.gif']
  ]);

  const ext=allowed.get(file.contentType);

  if(!ext)throw new Error('Only JPG, PNG, WEBP or GIF images are allowed');
  if(file.data.length>5*1024*1024)throw new Error('Image must be 5 MB or smaller');

  const publicId=`${Date.now()}-${safeFilename(prefix)}`;

  const result=await new Promise((resolve,reject)=>{
    const stream=cloudinary.uploader.upload_stream(
      {
        folder:`shree-steel/${folder}`,
        public_id:publicId,
        resource_type:'image'
      },
      (error,result)=>{
        if(error)return reject(error);
        resolve(result);
      }
    );

    stream.end(file.data);
  });

  return result.secure_url;
}
function safeEqual(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
async function sendOtpEmail(to,code){
  const apiKey=process.env.RESEND_API_KEY;
  if(!apiKey)return false;

  const {Resend}=require('resend');
  const resend=new Resend(apiKey);

  await resend.emails.send({
    from:'Shree Steel <onboarding@resend.dev>',
    to,
    subject:'Shree Steel Admin Verification Code',
    text:`Your Shree Steel Admin verification code is ${code}.\n\nThis 6-digit code expires in 10 minutes and can be used only once. If you did not request this code, ignore this email.`
  });

  return true;
}
function createAdminSession(res,email,recoveryVerified=false){
  const cookie=crypto.randomBytes(32).toString('hex');
  sessions.add(cookie);
  if(recoveryVerified) recoverySessions.add(cookie);
  const recoveryCookie=recoveryVerified
    ? `ss_admin_recovery=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.NODE_ENV==='production'?'; Secure':''}`
    : `ss_admin_recovery=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  return send(res,200,{ok:true,email,recovery_verified:!!recoveryVerified},{
    'Set-Cookie':[
      `ss_admin=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.NODE_ENV==='production'?'; Secure':''}`,
      recoveryCookie
    ]
  });
}

async function ensureProductQuoteConfiguration(){
  const configs={
    'TMT Steel':{unit:'KG',options:[['Diameter','8 mm'],['Diameter','10 mm'],['Diameter','12 mm'],['Diameter','16 mm'],['Diameter','20 mm'],['Diameter','25 mm'],['Diameter','32 mm']]},
    'Cement':{unit:'BAGS',options:[['Grade','43 Grade'],['Grade','53 Grade'],['Type','OPC'],['Type','PPC'],['Type','PSC']]},
    'Roofing Sheets':{unit:'PCS',options:[['Length','6 ft'],['Length','6.5 ft'],['Length','8 ft'],['Length','10 ft']]},
    'Structural Steel':{unit:'KG',options:[['Section','Angle'],['Section','Channel'],['Section','Beam'],['Section','Plate']]},
    'Bricks':{unit:'PCS',options:[['Type','Red Brick'],['Type','Fly Ash Brick']]},
    'Pipes & Steel Products':{unit:'PCS',options:[['Type','Round Pipe'],['Type','Square Pipe'],['Type','Rectangular Pipe']]}
  };
  for(const [name,cfg] of Object.entries(configs)){
    const p=await db.execute({sql:'SELECT id FROM products WHERE name=? LIMIT 1',args:[name]});
    if(!p.rows.length) continue;
    const pid=Number(p.rows[0].id);
    await db.execute({sql:"UPDATE products SET default_unit=COALESCE(NULLIF(default_unit,''),?) WHERE id=?",args:[cfg.unit,pid]});

    // Product specifications are independent of brands and brand varieties.
    // Remove legacy/incorrect "Variant: ..." values that were previously
    // leaking brand varieties into the product specification dropdown.
    await db.execute({
      sql:`DELETE FROM product_options
           WHERE product_id=?
             AND lower(trim(option_value)) LIKE 'variant:%'`,
      args:[pid]
    });

    const existingRows=await db.execute({
      sql:'SELECT option_name,option_value FROM product_options WHERE product_id=? AND available=1 ORDER BY sort_order,id',
      args:[pid]
    });
    const existingValues=new Set(existingRows.rows.map(r=>String(r.option_value||'').trim().toLowerCase()));

    // Add official product specifications that are missing, without
    // overwriting administrator-created specifications.
    let nextOrder=existingRows.rows.length+1;
    for(const [optionName,optionValue] of cfg.options){
      if(!existingValues.has(optionValue.toLowerCase())){
        await db.execute({
          sql:'INSERT OR IGNORE INTO product_options(product_id,option_name,option_value,sort_order,available) VALUES(?,?,?,?,1)',
          args:[pid,optionName,optionValue,nextOrder++]
        });
      }
    }
  }
}

async function saveProductQuoteConfiguration(productId,unit,rawOptions){
  const allowedUnits=new Set(['PCS','BAGS','KG','TON','MTR','SQFT','SQM','LTR']);
  const rawUnit=String(unit||'').trim();
  const normalizedUnit=rawUnit.toUpperCase();
  const defaultUnit=rawUnit
    ? (allowedUnits.has(normalizedUnit)?normalizedUnit:rawUnit.slice(0,20))
    : 'PCS';
  let options=[];
  try{options=Array.isArray(rawOptions)?rawOptions:JSON.parse(String(rawOptions||'[]'))}catch{throw new Error('Invalid product specifications data')}
  options=options.map((o,i)=>({name:String(o?.name||'Specification').trim()||'Specification',value:String(o?.value||'').trim(),sort_order:i+1})).filter(o=>o.value);
  await db.execute({sql:'UPDATE products SET default_unit=? WHERE id=?',args:[defaultUnit,productId]});
  await db.execute({sql:'DELETE FROM product_options WHERE product_id=?',args:[productId]});
  for(const o of options) await db.execute({sql:'INSERT INTO product_options(product_id,option_name,option_value,sort_order,available) VALUES(?,?,?,?,1)',args:[productId,o.name,o.value,o.sort_order]});
}

async function initializeDatabase() {
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS products(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        brands TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        available INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS brands(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        accent TEXT NOT NULL DEFAULT '#087fe3',
        logo TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS brand_varieties(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        product_image TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        visible INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS product_options(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        option_name TEXT NOT NULL DEFAULT 'Specification',
        option_value TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        available INTEGER NOT NULL DEFAULT 1,
        UNIQUE(product_id, option_value)
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS product_units(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS enquiries(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        product TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'New',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    }
  ]);

  const standardUnits=['PCS','BAGS','KG','TON','MTR','SQFT','SQM','LTR'];
  for(const unit of standardUnits){
    await db.execute({sql:'INSERT OR IGNORE INTO product_units(name,sort_order) VALUES(?,?)',args:[unit,standardUnits.indexOf(unit)+1]});
  }
  const existingProductUnits=await db.execute(`SELECT DISTINCT TRIM(default_unit) AS unit FROM products WHERE TRIM(COALESCE(default_unit,''))<>''`);
  for(const row of existingProductUnits.rows){
    const unit=String(row.unit||'').trim();
    if(unit) await db.execute({sql:'INSERT OR IGNORE INTO product_units(name,sort_order) VALUES(?,?)',args:[unit,1000]});
  }

  await ensureColumn('products','visible','INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('products','default_unit',"TEXT NOT NULL DEFAULT 'PCS'");
  await ensureColumn('brands','product_id','INTEGER');
  await ensureColumn('brands','variety',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('brands','product_image',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('brands','visible','INTEGER NOT NULL DEFAULT 1');

  // Migrate the old single-variety fields into the proper one-to-many model.
  const legacyVarieties = await db.execute(`
    SELECT b.id,b.name,b.variety,b.product_image
    FROM brands b
    WHERE TRIM(COALESCE(b.variety,''))<>'' OR TRIM(COALESCE(b.product_image,''))<>''
  `);
  for (const row of legacyVarieties.rows) {
    const existing = await db.execute({sql:'SELECT id FROM brand_varieties WHERE brand_id=? LIMIT 1',args:[Number(row.id)]});
    if (!existing.rows.length && String(row.variety||'').trim()) {
      await db.execute({
        sql:'INSERT INTO brand_varieties(brand_id,name,product_image,sort_order,visible) VALUES(?,?,?,?,1)',
        args:[Number(row.id),String(row.variety).trim(),String(row.product_image||''),0]
      });
    }
  }

  await ensureColumn('admin_accounts','otp_challenge_hash',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('admin_accounts','otp_code_hash',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('admin_accounts','otp_expires_at',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('admin_accounts','otp_purpose',"TEXT NOT NULL DEFAULT ''");
  await ensureColumn('admin_accounts','otp_attempts','INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('admin_accounts','otp_last_sent_at',"TEXT NOT NULL DEFAULT ''");
  await ensureAdminAccount();

  const officialBrands = [
    ['Bangur Cement','CEMENT','Cement products','#d51f28','/assets/brands/bangur-cement.jpeg',1],
    ['Everest','ROOFING SOLUTION','Roofing solutions','#d62b25','/assets/brands/everest-roofing.webp',2],
    ['GK TMT','TMT BARS','TMT reinforcement steel','#e32728','/assets/brands/gk-tmt.jpeg',3],
    ['HIL Charminar','ROOFING SHEETS','HIL Charminar roofing sheets.','#1677b8','/assets/brands/hil-birla-nu.png',4],
    ['Jindal Bricks','BRICKS','Construction bricks','#c45732','',8]
  ];

  for (const x of officialBrands) {
    const existing = await db.execute({
      sql: 'SELECT id FROM brands WHERE name=?',
      args: [x[0]]
    });

    if (existing.rows.length) {
      await db.execute({
        sql: 'UPDATE brands SET category=?,description=?,accent=?,logo=? WHERE name=?',
        args: [x[1], x[2], x[3], x[4], x[0]]
      });
    } else {
      const next = await appendPriority('brands');
      await db.execute({
        sql: 'INSERT INTO brands(name,category,description,accent,logo,sort_order) VALUES(?,?,?,?,?,?)',
        args: [x[0],x[1],x[2],x[3],x[4],next]
      });
    }
  }

  // Preserve the existing TMT record instead of creating a duplicate.
  const tmtSteel=await db.execute("SELECT id FROM products WHERE lower(name)='tmt steel' LIMIT 1");
  const tmtBars=await db.execute("SELECT id FROM products WHERE lower(name)='tmt bars' LIMIT 1");
  if(!tmtSteel.rows.length && tmtBars.rows.length){
    await db.execute({sql:"UPDATE products SET name='TMT Steel',category='TMT STEEL' WHERE id=?",args:[Number(tmtBars.rows[0].id)]});
  }

  // Remove the obsolete duplicate TMT Bars product when TMT Steel already exists.
  if(tmtSteel.rows.length && tmtBars.rows.length){
    const legacyTmtBarsId=Number(tmtBars.rows[0].id);
    const legacyBrands=await db.execute({sql:'SELECT COUNT(*) AS count FROM brands WHERE product_id=?',args:[legacyTmtBarsId]});
    if(Number(legacyBrands.rows[0]?.count)===0){
      await db.execute({sql:'DELETE FROM products WHERE id=?',args:[legacyTmtBarsId]});
    }
  }

  const coreProducts = [
    ['TMT Steel','TMT STEEL','','Premium TMT reinforcement steel for residential, commercial and project construction.',1,1,'KG'],
    ['Cement','CEMENT','','Trusted cement solutions for foundations, slabs, columns and general construction.',1,2,'BAGS'],
    ['Roofing Sheets','ROOFING','','Roofing options for residential, commercial, agricultural and industrial applications.',1,3,'PCS'],
    ['Bricks','MASONRY','','Construction bricks for walls, foundations and building work.',1,5,'PCS'],
  ];
  for(const x of coreProducts){
    const existing=await db.execute({sql:'SELECT id FROM products WHERE name=?',args:[x[0]]});
    if(existing.rows.length) await db.execute({sql:`UPDATE products SET description=?,available=?,visible=COALESCE(visible,1),default_unit=COALESCE(NULLIF(default_unit,''),?) WHERE name=?`,args:[x[3],x[4],x[6],x[0]]});
    else { const next=await appendPriority('products'); await db.execute({sql:`INSERT INTO products(name,category,brands,description,available,sort_order,visible,default_unit) VALUES(?,?,?,?,?,?,?,?)`,args:[x[0],x[1],x[2],x[3],x[4],next,1,x[6]]}); }
  }
  await ensureProductQuoteConfiguration();
  // Remove obsolete duplicate MSP brand from TMT Steel.
  const tmtForMspCleanup = await db.execute("SELECT id FROM products WHERE lower(name)='tmt steel' LIMIT 1");
  if (tmtForMspCleanup.rows.length) {
    const tmtIdForMspCleanup = Number(tmtForMspCleanup.rows[0].id);
    await db.execute({
      sql: "DELETE FROM brand_varieties WHERE brand_id IN (SELECT id FROM brands WHERE name='MSP' AND product_id=?)",
      args: [tmtIdForMspCleanup]
    });
    await db.execute({
      sql: "DELETE FROM brands WHERE name='MSP' AND product_id=?",
      args: [tmtIdForMspCleanup]
    });
  }       
  await resolveLegacyBrandProductIds();
  await resolveLegacyBrandProductIds();
  const pipesProduct=await db.execute("SELECT id FROM products WHERE lower(name)='pipes' LIMIT 1");
if(pipesProduct.rows.length){
  await db.execute({sql:"UPDATE products SET visible=1,available=1 WHERE id=?",args:[Number(pipesProduct.rows[0].id)]});
}

// Permanently remove obsolete catalog records.
await db.execute("DELETE FROM brand_varieties WHERE brand_id IN (SELECT id FROM brands WHERE name='Jindal Panther' AND product_id=(SELECT id FROM products WHERE lower(name)='tmt steel' LIMIT 1))");
await db.execute("DELETE FROM brands WHERE name='Jindal Panther' AND product_id=(SELECT id FROM products WHERE lower(name)='tmt steel' LIMIT 1)");
await db.execute("DELETE FROM brands WHERE name='Jindal Cement'");
await db.execute("DELETE FROM brand_varieties WHERE brand_id IN (SELECT id FROM brands WHERE name='Jindal Steel & Power Limited')");
await db.execute("DELETE FROM brands WHERE name='Jindal Steel & Power Limited'");
await db.execute("DELETE FROM brand_varieties WHERE brand_id IN (SELECT id FROM brands WHERE name='HIL / BirlaNu' AND product_id=(SELECT id FROM products WHERE lower(name)='roofing sheets' LIMIT 1))");
await db.execute("DELETE FROM brands WHERE name='HIL / BirlaNu' AND product_id=(SELECT id FROM products WHERE lower(name)='roofing sheets' LIMIT 1)");
await db.execute("DELETE FROM product_options WHERE product_id=(SELECT id FROM products WHERE lower(name)='roofing sheets' LIMIT 1) AND lower(trim(option_value)) NOT IN ('6 ft','6.5 ft','8 ft','10 ft')");
await db.execute("UPDATE product_options SET sort_order=CASE lower(trim(option_value)) WHEN '6 ft' THEN 1 WHEN '6.5 ft' THEN 2 WHEN '8 ft' THEN 3 WHEN '10 ft' THEN 4 END WHERE product_id=(SELECT id FROM products WHERE lower(name)='roofing sheets' LIMIT 1) AND lower(trim(option_value)) IN ('6 ft','6.5 ft','8 ft','10 ft')");
await db.execute("DELETE FROM products WHERE lower(name) IN ('structural steel','pipes & steel products','round pipes','square pipes')");
  await normalizePriorities('products');
  await normalizePriorities('brands');
  const brandRowsForNormalization = await db.execute('SELECT id FROM brands ORDER BY id');
  for (const row of brandRowsForNormalization.rows) await normalizePriorities('brand_varieties','brand_id=?',[Number(row.id)]);

}


async function normalizePriorities(table, whereSql='', whereArgs=[]) {
  const rows = await db.execute({
    sql: `SELECT id FROM ${table}${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY sort_order,id`,
    args: whereArgs
  });
  for (let i = 0; i < rows.rows.length; i++) {
    await db.execute({sql:`UPDATE ${table} SET sort_order=? WHERE id=?`,args:[i+1,Number(rows.rows[i].id)]});
  }
}

async function appendPriority(table, whereSql='', whereArgs=[]) {
  const r = await db.execute({
    sql: `SELECT COALESCE(MAX(sort_order),0) AS max_order FROM ${table}${whereSql ? ` WHERE ${whereSql}` : ''}`,
    args: whereArgs
  });
  return Number(r.rows[0]?.max_order || 0) + 1;
}

async function movePriority(table, id, requested, whereSql='', whereArgs=[]) {
  const currentR = await db.execute({
    sql: `SELECT sort_order FROM ${table} WHERE id=?${whereSql ? ` AND ${whereSql}` : ''} LIMIT 1`,
    args: [id, ...whereArgs]
  });
  if (!currentR.rows.length) throw new Error('Item not found');
  const current = Number(currentR.rows[0].sort_order) || 1;
  const countR = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM ${table}${whereSql ? ` WHERE ${whereSql}` : ''}`,
    args: whereArgs
  });
  const count = Number(countR.rows[0]?.count || 0);
  const target = Math.max(1, Math.min(Number(requested) || current, count));
  if (target === current) return current;

  // Temporarily move the selected item out of the active range so there is no collision.
  await db.execute({sql:`UPDATE ${table} SET sort_order=0 WHERE id=?`,args:[id]});
  if (current < target) {
    await db.execute({
      sql:`UPDATE ${table} SET sort_order=sort_order-1 WHERE sort_order>? AND sort_order<=?${whereSql ? ` AND ${whereSql}` : ''}`,
      args:[current,target,...whereArgs]
    });
  } else {
    await db.execute({
      sql:`UPDATE ${table} SET sort_order=sort_order+1 WHERE sort_order>=? AND sort_order<?${whereSql ? ` AND ${whereSql}` : ''}`,
      args:[target,current,...whereArgs]
    });
  }
  await db.execute({sql:`UPDATE ${table} SET sort_order=? WHERE id=?`,args:[target,id]});
  return target;
}

async function saveBrandVarieties(brandId,brandName,rawVarieties,files){
  let varieties=[];
  try{varieties=Array.isArray(rawVarieties)?rawVarieties:JSON.parse(String(rawVarieties||'[]'))}catch{throw new Error('Invalid brand varieties data')}
  varieties=varieties.map((v,i)=>({
    name:String(v?.name||'').trim(),
    product_image:String(v?.product_image||'').trim(),
    sort_order:Math.max(1,Number(v?.sort_order)||i+1),
    visible:Number(v?.visible)?1:0,
    file_index:Number.isInteger(Number(v?.fileIndex))?Number(v.fileIndex):null
  })).filter(v=>v.name);
  for(let i=0;i<varieties.length;i++){
    const f=varieties[i].file_index===null?null:files.find(x=>x.field===`variety_image_${varieties[i].file_index}`);
    if(f)varieties[i].product_image=await saveUploadedImage(f,'products',`${brandName}-${varieties[i].name}`);
  }
  await db.execute({sql:'DELETE FROM brand_varieties WHERE brand_id=?',args:[brandId]});
  for(const v of varieties){
    await db.execute({sql:'INSERT INTO brand_varieties(brand_id,name,product_image,sort_order,visible) VALUES(?,?,?,?,?)',args:[brandId,v.name,v.product_image,v.sort_order,v.visible]});
  }
  await normalizePriorities('brand_varieties','brand_id=?',[brandId]);
}

function send(res, status, obj, headers = {}) {
  const b = Buffer.from(
    typeof obj === 'string' ? obj : JSON.stringify(obj)
  );

  res.writeHead(status, {
    'Content-Type':
      typeof obj === 'string'
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
    'Content-Length': b.length,
    ...headers
  });

  res.end(b);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';

    req.on('data', c => {
      d += c;
      if (d.length > 2e6) req.destroy();
    });

    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });

    req.on('error', reject);
  });
}

function sig(v) {
  return crypto.createHmac('sha256', SECRET).update(v).digest('hex');
}

function admin(req) {
  const token=parseCookies(req).ss_admin;
  return !!token && sessions.has(token);
}

function recoveryAdmin(req) {
  const cookies=parseCookies(req);
  const token=cookies.ss_admin;
  return !!token && sessions.has(token) &&
    (recoverySessions.has(token) || cookies.ss_admin_recovery === '1');
}

function need(req, res) {
  if (!admin(req)) {
    send(res, 401, { error: 'Unauthorized' });
    return false;
  }

  return true;
}

function staticFile(res, file) {
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp'
  };

  fs.readFile(file, (e, b) => {
    if (e) return send(res, 404, 'Not found');

    res.writeHead(200, {
      'Content-Type':
        map[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });

    res.end(b);
  });
}



function productPageSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function productPageEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function productPageUrl(productName, brandName, varietyName) {
  const parts = ['/products', productPageSlug(productName)];

  if (brandName) parts.push(productPageSlug(brandName));
  if (varietyName) parts.push(productPageSlug(varietyName));

  return parts.join('/');
}

async function findProductPageData(pathParts) {
  if (!Array.isArray(pathParts) || pathParts.length < 1 || pathParts.length > 3) {
    return null;
  }

  const productSlug = pathParts[0];
  const productResult = await db.execute({
    sql: 'SELECT * FROM products WHERE available=1 AND visible=1 ORDER BY sort_order,id',
    args: []
  });

  const product = productResult.rows.find(
    p => productPageSlug(p.name) === productSlug
  );

  if (!product) return null;

  const brandResult = await db.execute({
    sql: 'SELECT * FROM brands WHERE product_id=? AND COALESCE(visible,1)=1 ORDER BY sort_order,id',
    args: [Number(product.id)]
  });

  const brands = [];

  for (const brand of brandResult.rows) {
    const varietyResult = await db.execute({
      sql: 'SELECT id,name,product_image,sort_order,visible FROM brand_varieties WHERE brand_id=? ORDER BY sort_order,id',
      args: [Number(brand.id)]
    });

    brands.push({
      ...brand,
      varieties: varietyResult.rows
    });
  }

  if (pathParts.length === 1) {
    return { level: 'product', product, brands };
  }

  const brand = brands.find(
    b => productPageSlug(b.name) === pathParts[1]
  );

  if (!brand) return null;

  if (pathParts.length === 2) {
    return { level: 'brand', product, brand, brands };
  }

  const variety = brand.varieties.find(
    v => productPageSlug(v.name) === pathParts[2] && Number(v.visible) !== 0
  );

  if (!variety) return null;

  return {
    level: 'variety',
    product,
    brand,
    variety,
    brands
  };
}

function renderProductPage(data, req) {
  const product = data.product;
  const brand = data.brand;
  const variety = data.variety;

  let title = product.name;
  let description = product.description || '';

  if (data.level === 'brand') {
    title = brand.name + ' - ' + product.name;
    description = brand.description || description;
  }

  if (data.level === 'variety') {
    title = variety.name + ' - ' + brand.name + ' - ' + product.name;
    description =
      'Enquire about ' + variety.name + ' from ' + brand.name +
      ' through Shree Steel Ambikapur.';
  }

  const slugParts = [productPageSlug(product.name)];
  if (brand) slugParts.push(productPageSlug(brand.name));
  if (variety) slugParts.push(productPageSlug(variety.name));

  const canonical =
  'https://shreesteelambikapur.onrender.com/products/' +
    slugParts.join('/');

  const heading =
    data.level === 'variety'
      ? variety.name
      : data.level === 'brand'
        ? brand.name
        : product.name;

  const subheading =
    data.level === 'variety'
      ? brand.name + ' � ' + product.name
      : data.level === 'brand'
        ? product.name
        : product.category || 'Construction Materials';

  const logo = brand && brand.logo ? brand.logo : '';

  const brandsMarkup = data.brands.length
    ? data.brands.map(b => {
        const href = productPageUrl(product.name, b.name);
        const bLogo = b.logo || '';

        return '<a class="product-page-brand" href="' +
          productPageEscape(href) + '">' +
          (bLogo
            ? '<img src="' + productPageEscape(bLogo) +
              '" alt="' + productPageEscape(b.name) + ' logo">'
            : '') +
          '<strong>' + productPageEscape(b.name) + '</strong>' +
          '</a>';
      }).join('')
    : '<p>No brand information is currently listed.</p>';

  const varietiesMarkup =
    data.level !== 'product' && brand && brand.varieties.length
      ? '<div class="product-page-varieties"><h2>Available Products / Varieties</h2>' +
        brand.varieties.filter(v => Number(v.visible) !== 0).map(v => {
          const href = productPageUrl(product.name, brand.name, v.name);
          return '<a class="product-page-variety" href="' +
            productPageEscape(href) + '">' +
            (v.product_image
              ? '<img src="' + productPageEscape(v.product_image) +
                '" alt="' + productPageEscape(v.name) + '">'
              : '') +
            '<strong>' + productPageEscape(v.name) + '</strong>' +
            '</a>';
        }).join('') +
        '</div>'
      : '';

  const varietyImage =
    variety && variety.product_image
      ? '<img class="product-page-main-image" src="' +
        productPageEscape(variety.product_image) +
        '" alt="' + productPageEscape(variety.name) + '">'
      : '';

  return '<!doctype html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="index,follow">' +
    '<link rel="canonical" href="' + productPageEscape(canonical) + '">' +
    '<link rel="icon" type="image/png" href="/assets/shree-steel-favicon.png">' +
    '<meta name="description" content="' +
      productPageEscape(description) + '">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:site_name" content="Shree Steel">' +
    '<meta property="og:title" content="' +
      productPageEscape(title + ' | Shree Steel Ambikapur') + '">' +
    '<meta property="og:description" content="' +
      productPageEscape(description) + '">' +
    '<meta property="og:url" content="' +
      productPageEscape(canonical) + '">' +
    '<title>' +
      productPageEscape(title + ' | Shree Steel Ambikapur') +
    '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="/site.css">' +
    '<style>' +
      '.product-page{padding:90px 0;background:#f5f8fc;min-height:70vh}' +
      '.product-page-card{background:#fff;border:1px solid #e4e9f2;border-radius:28px;padding:38px;box-shadow:0 12px 40px rgba(20,28,60,.08)}' +
      '.product-page-kicker{font-size:11px;color:#087fe3;font-weight:900;letter-spacing:.13em;text-transform:uppercase}' +
      '.product-page h1{font-size:clamp(38px,5vw,64px);line-height:1;letter-spacing:-.05em;color:#19104f;margin:12px 0}' +
      '.product-page-sub{color:#687184;font-weight:800;font-size:12px}' +
      '.product-page-description{max-width:780px;color:#687184;line-height:1.8;font-size:15px;margin:22px 0}' +
      '.product-page-main-image{display:block;max-width:420px;max-height:320px;width:100%;object-fit:contain;margin:20px 0;border-radius:18px}' +
      '.product-page-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:25px}' +
      '.product-page-brands,.product-page-varieties{margin-top:45px}' +
      '.product-page-brands h2,.product-page-varieties h2{font-size:25px;color:#19104f}' +
      '.product-page-brand,.product-page-variety{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #e1e6ef;border-radius:15px;background:#fafbfe;margin-top:10px}' +
      '.product-page-brand img,.product-page-variety img{width:80px;height:55px;object-fit:contain;background:#fff;border-radius:9px;padding:5px}' +
      '.product-page-variety{display:inline-flex;margin-right:10px;vertical-align:top}' +
      '.product-page-back{display:inline-block;margin-bottom:25px;color:#087fe3;font-weight:900;font-size:11px}' +
      '@media(max-width:600px){.product-page{padding:60px 0}.product-page-card{padding:24px}.product-page-actions .btn{width:100%}}' +
    '</style></head><body>' +
    '<header><div class="container nav">' +
      '<a href="/"><img src="/assets/shree-steel-logo.png" class="logo" alt="Shree Steel"></a>' +
      '<nav><a href="/">HOME</a><a href="/#products">PRODUCTS &amp; BRANDS</a><a href="/#calculator">CALCULATOR</a><a href="/#about">ABOUT</a><a href="/#contact">CONTACT</a></nav>' +
      '<a class="btn primary" href="/#contact">GET A QUOTE</a>' +
      '<button class="hamb" type="button" onclick="document.querySelector(\'nav\').classList.toggle(\'mobile\')">?</button>' +
    '</div></header>' +
    '<main class="product-page"><div class="container">' +
      '<a class="product-page-back" href="/#products">&#8592; BACK TO PRODUCTS</a>' +
      '<article class="product-page-card">' +
        '<div class="product-page-kicker">' + productPageEscape(subheading) + '</div>' +
        '<h1>' + productPageEscape(heading) + '</h1>' +
        '<p class="product-page-description">' + productPageEscape(description) + '</p>' +
        varietyImage +
        '<div class="product-page-actions">' +
          '<a class="btn primary" href="/?quote=' + encodeURIComponent(product.name) + '">REQUEST A QUOTE →</a>' +
          '<a class="btn ghost" href="/#products">VIEW ALL PRODUCTS</a>' +
        '</div>' +
        (data.level === 'product'
          ? '<section class="product-page-brands"><h2>Trusted Brands</h2>' +
            brandsMarkup + '</section>'
          : '') +
        varietiesMarkup +
      '</article>' +
    '</div></main>' +
    '<footer><div class="container"><div class="copyright">� Shree Steel Ambikapur. All rights reserved.</div></div></footer>' +
    '</body></html>';
}


async function productPageSitemapXml() {
  const baseUrl = 'https://shreesteelambikapur.onrender.com';

  const productResult = await db.execute({
    sql: 'SELECT id,name FROM products WHERE available=1 AND visible=1 ORDER BY sort_order,id',
    args: []
  });

  const urls = [`${baseUrl}/`];

  for (const product of productResult.rows) {
    const productUrl =
      `${baseUrl}/products/${productPageSlug(product.name)}`;

    urls.push(productUrl);

    const brandResult = await db.execute({
      sql: 'SELECT id,name FROM brands WHERE product_id=? AND COALESCE(visible,1)=1 ORDER BY sort_order,id',
      args: [Number(product.id)]
    });

    for (const brand of brandResult.rows) {
      const brandUrl =
        `${productUrl}/${productPageSlug(brand.name)}`;

      urls.push(brandUrl);

      const varietyResult = await db.execute({
        sql: 'SELECT name FROM brand_varieties WHERE brand_id=? AND COALESCE(visible,1)=1 ORDER BY sort_order,id',
        args: [Number(brand.id)]
      });

      for (const variety of varietyResult.rows) {
        urls.push(
          `${brandUrl}/${productPageSlug(variety.name)}`
        );
      }
    }
  }

  const escapeXml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${escapeXml(url)}</loc>
  </url>`).join('\n')}
</urlset>`;
}


async function startServer() {
  await initializeDatabase();

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
      );

      const p = u.pathname;

      if (req.method === 'GET' && p === '/api/products') {
        const r=await db.execute(`SELECT p.*,(SELECT COUNT(*) FROM brands b WHERE b.product_id=p.id AND COALESCE(b.visible,1)=1) AS brand_count FROM products p ORDER BY p.sort_order,p.id`);
        const rows=[];
        for(const p of r.rows){
          const o=await db.execute({sql:'SELECT id,option_name,option_value,sort_order,available FROM product_options WHERE product_id=? AND available=1 ORDER BY sort_order,id',args:[Number(p.id)]});
          rows.push({...p,options:o.rows.map(x=>({id:Number(x.id),name:x.option_name,value:x.option_value,sort_order:Number(x.sort_order)||0}))});
        }
        return send(res,200,rows);
      }
      if (req.method === 'GET' && p === '/api/brands') {
        const r=await db.execute(`SELECT b.*,p.name AS product_name FROM brands b LEFT JOIN products p ON p.id=b.product_id ORDER BY COALESCE(p.sort_order,999999),p.id,b.id`);
        const rows=[];
        for(const b of r.rows){
          const vr=await db.execute({sql:`SELECT id,name,product_image,sort_order,visible FROM brand_varieties WHERE brand_id=? ORDER BY sort_order,id`,args:[Number(b.id)]});
          rows.push({...b,varieties:vr.rows.map(v=>({id:Number(v.id),name:v.name,product_image:v.product_image||'',sort_order:Number(v.sort_order)||0,visible:Number(v.visible)!==0}))});
        }
        return send(res,200,rows);
      }

      if (req.method === 'GET' && p === '/api/quote-data') {
        // quote-data product option cleanup: brand varieties are never specifications.
        await db.execute(`DELETE FROM product_options WHERE lower(trim(option_value)) LIKE 'variant:%'`);
        const productRows = await db.execute({
          sql: `
            SELECT id, name, category, description, default_unit
            FROM products
            WHERE available=1 AND visible=1
            ORDER BY sort_order,id
          `
        });

        const products = [];

        for (const product of productRows.rows) {
          const brandRows = await db.execute({
            sql: `
              SELECT b.id,b.name,b.variety,b.logo,b.product_image
              FROM brands b
              WHERE b.product_id=? AND COALESCE(b.visible,1)=1
              ORDER BY b.id
            `,
            args: [Number(product.id)]
          });

          const optionRows = await db.execute({
            sql: `
              SELECT id, option_name, option_value
              FROM product_options
              WHERE product_id=? AND available=1
              ORDER BY sort_order,id
            `,
            args: [Number(product.id)]
          });

          products.push({
            id: Number(product.id),
            name: product.name,
            category: product.category,
            description: product.description,
            unit: product.default_unit,
            brands: await Promise.all(brandRows.rows.map(async b => {
              const vr=await db.execute({sql:`SELECT id,name,product_image,sort_order,visible FROM brand_varieties WHERE brand_id=? AND COALESCE(visible,1)=1 ORDER BY sort_order,id`,args:[Number(b.id)]});
              return {id:Number(b.id),name:b.name,variety:b.variety||'',logo:b.logo||'',product_image:b.product_image||'',varieties:vr.rows.map(v=>({id:Number(v.id),name:v.name,product_image:v.product_image||'',sort_order:Number(v.sort_order)||0,visible:Number(v.visible)!==0}))};
            })),
            options: optionRows.rows.map(o => ({
              id: Number(o.id),
              name: o.option_name,
              value: o.option_value
            }))
          });
        }

        return send(res, 200, { products });
      }
      if (req.method === 'POST' && p === '/api/quote') {
        const x = await body(req);

        const name = String(x.name || '').trim();
        const phone = String(x.phone || '').trim();
        const location = String(x.location || '').trim();
        const additionalRequirement =
          String(x.additionalRequirement || '').trim();

        const items = Array.isArray(x.items) ? x.items : [];

        if (!name || !phone) {
          return send(res, 400, {
            error: 'Name and phone are required'
          });
        }

        if (items.length === 0) {
          return send(res, 400, {
            error: 'At least one product is required'
          });
        }

        if (items.length > 50) {
          return send(res, 400, {
            error: 'Too many quote items'
          });
        }

        // --------------------------------------------------------
        // Validate customer phone
        // --------------------------------------------------------

        const cleanPhone = phone.replace(/[\s-]/g, '');

        if (!/^\+?[0-9]{10,15}$/.test(cleanPhone)) {
          return send(res, 400, {
            error: 'Please enter a valid mobile number'
          });
        }

        // --------------------------------------------------------
        // Find or create customer
        // --------------------------------------------------------

        let customer = await db.execute({
          sql: `
            SELECT id
            FROM customers
            WHERE phone=?
            LIMIT 1
          `,
          args: [cleanPhone]
        });

        let customerId;

        if (customer.rows.length) {
          customerId = Number(customer.rows[0].id);

          await db.execute({
            sql: `
              UPDATE customers
              SET name=?, location=?
              WHERE id=?
            `,
            args: [
              name,
              location,
              customerId
            ]
          });
        } else {
          const r = await db.execute({
            sql: `
              INSERT INTO customers(
                name,
                phone,
                location
              )
              VALUES(?,?,?)
            `,
            args: [
              name,
              cleanPhone,
              location
            ]
          });

          customerId = Number(r.lastInsertRowid);
        }

        // --------------------------------------------------------
        // Validate and prepare every quote item
        // --------------------------------------------------------

        const preparedItems = [];

        for (const item of items) {
          const productId = Number(item.productId);
          const brandId =
            item.brandId === null ||
            item.brandId === undefined ||
            item.brandId === ''
              ? null
              : Number(item.brandId);

          const quantity = Number(item.quantity);

          if (!Number.isInteger(productId) || productId <= 0) {
            return send(res, 400, {
              error: 'Invalid product'
            });
          }

          if (
            brandId !== null &&
            (!Number.isInteger(brandId) || brandId <= 0)
          ) {
            return send(res, 400, {
              error: 'Invalid brand'
            });
          }

          if (!Number.isFinite(quantity) || quantity <= 0) {
            return send(res, 400, {
              error: 'Quantity must be greater than zero'
            });
          }

          if (quantity > 1000000) {
            return send(res, 400, {
              error: 'Quantity is too large'
            });
          }

          // ------------------------------------------------------
          // Product must be customer-available
          // ------------------------------------------------------

          const product = await db.execute({
            sql: `
              SELECT
                id,
                name,
                default_unit,
                available,
                visible
              FROM products
              WHERE id=?
              LIMIT 1
            `,
            args: [productId]
          });

          if (!product.rows.length) {
            return send(res, 400, {
              error: 'Product not found'
            });
          }

          const pRow = product.rows[0];

          if (!Number(pRow.available) || !Number(pRow.visible)) {
            return send(res, 400, {
              error: `${pRow.name} is currently unavailable`
            });
          }

          // ------------------------------------------------------
          // Validate brand ↔ product relationship
          // ------------------------------------------------------

          if (brandId !== null) {
            const relationship = await db.execute({
              sql: `
                SELECT 1 FROM brands WHERE product_id=? AND id=? AND COALESCE(visible,1)=1
                LIMIT 1
              `,
              args: [
                productId,
                brandId
              ]
            });

            if (!relationship.rows.length) {
              return send(res, 400, {
                error: 'Selected brand is not available for this product'
              });
            }

            const brand = await db.execute({
              sql: `
                SELECT id, name, visible
                FROM brands
                WHERE id=?
                LIMIT 1
              `,
              args: [brandId]
            });

            if (
              !brand.rows.length ||
              !Number(brand.rows[0].visible)
            ) {
              return send(res, 400, {
                error: 'Selected brand is unavailable'
              });
            }
          }

          // ------------------------------------------------------
          // Specification / Brand Variety
          // ------------------------------------------------------

          const specification =
            String(item.specification || '').trim();

          if (specification) {
            const isCement = String(pRow.name || '').trim().toLowerCase() === 'cement';

            if (isCement) {
              if (brandId === null) {
                return send(res, 400, {
                  error: 'Please select a cement brand before selecting its variety'
                });
              }

              const variety = await db.execute({
                sql: `
                  SELECT v.id
                  FROM brand_varieties v
                  WHERE v.brand_id=?
                    AND lower(trim(v.name))=lower(trim(?))
                    AND COALESCE(v.visible,1)=1
                  LIMIT 1
                `,
                args: [
                  brandId,
                  specification
                ]
              });

              if (!variety.rows.length) {
                return send(res, 400, {
                  error: 'Invalid cement brand variety'
                });
              }
            } else {
              const option = await db.execute({
                sql: `
                  SELECT id
                  FROM product_options
                  WHERE product_id=?
                    AND option_value=?
                    AND available=1
                  LIMIT 1
                `,
                args: [
                  productId,
                  specification
                ]
              });

              if (!option.rows.length) {
                return send(res, 400, {
                  error: 'Invalid product specification'
                });
              }
            }
          }

          // ------------------------------------------------------
          // Unit comes from the database, NOT the browser
          // ------------------------------------------------------

          const unit = String(pRow.default_unit);

          preparedItems.push({
            productId,
            brandId,
            specification,
            quantity,
            unit
          });
        }

        // --------------------------------------------------------
        // Generate unique enquiry number
        // --------------------------------------------------------

        let enquiryNo;

        for (let attempt = 0; attempt < 5; attempt++) {
          const stamp = new Date()
            .toISOString()
            .replace(/\D/g, '')
            .slice(0, 14);

          const random = crypto
            .randomBytes(4)
            .toString('hex')
            .toUpperCase();

          const candidate = `SS-${stamp}-${random}`;

          const existing = await db.execute({
            sql: `
              SELECT id
              FROM quote_enquiries
              WHERE enquiry_no=?
              LIMIT 1
            `,
            args: [candidate]
          });

          if (!existing.rows.length) {
            enquiryNo = candidate;
            break;
          }
        }

        if (!enquiryNo) {
          return send(res, 500, {
            error: 'Could not create enquiry number'
          });
        }

        // --------------------------------------------------------
        // Create quote
        // --------------------------------------------------------

        const quote = await db.execute({
          sql: `
            INSERT INTO quote_enquiries(
              enquiry_no,
              customer_id,
              additional_requirement,
              status
            )
            VALUES(?,?,?,?)
          `,
          args: [
            enquiryNo,
            customerId,
            additionalRequirement,
            'NEW'
          ]
        });

        const enquiryId =
          Number(quote.lastInsertRowid);

        // --------------------------------------------------------
        // Insert all quote items
        // --------------------------------------------------------

        for (const item of preparedItems) {
          await db.execute({
            sql: `
              INSERT INTO quote_items(
                enquiry_id,
                product_id,
                brand_id,
                specification,
                quantity,
                unit
              )
              VALUES(?,?,?,?,?,?)
            `,
            args: [
              enquiryId,
              item.productId,
              item.brandId,
              item.specification,
              item.quantity,
              item.unit
            ]
          });
        }

        return send(res, 200, {
          ok: true,
          enquiryNo,
          enquiryId,
          itemCount: preparedItems.length
        });
      }
      if (req.method === 'POST' && p === '/api/enquiries') {
        const x = await body(req);

        if (!x.name || !x.phone) {
          return send(res, 400, {
            error: 'Name and phone are required'
          });
        }

        const r = await db.execute({
          sql: `INSERT INTO enquiries(name,phone,product,message)
                VALUES(?,?,?,?)`,
          args: [
            String(x.name).trim(),
            String(x.phone).trim(),
            String(x.product || ''),
            String(x.message || '')
          ]
        });

        return send(res, 200, {
          ok: true,
          id: Number(r.lastInsertRowid)
        });
      }

      if(req.method==='POST'&&p==='/api/admin/login'){
        const x=await body(req),email=String(x.email||'').trim().toLowerCase(),password=String(x.password||'');
        const r=await db.execute({sql:'SELECT id,email,password_hash FROM admin_accounts WHERE lower(email)=? LIMIT 1',args:[email]});
        if(!r.rows.length||!(await bcrypt.compare(password,r.rows[0].password_hash)))return send(res,401,{error:'Incorrect email or password'});
        return createAdminSession(res,r.rows[0].email);
      }

      if(req.method==='POST'&&p==='/api/admin/logout'){
        const token=parseCookies(req).ss_admin;
        if(token){sessions.delete(token);recoverySessions.delete(token);}
        return send(res,200,{ok:true},{'Set-Cookie':[
          'ss_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          'ss_admin_recovery=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
        ]});
      }

      if(req.method==='GET'&&p==='/api/admin/me'){
        if(!admin(req))return send(res,200,{authenticated:false});
        const r=await db.execute('SELECT email,recovery_email_1,recovery_email_2 FROM admin_accounts ORDER BY id LIMIT 1'),a=r.rows[0]||{};
        return send(res,200,{authenticated:true,email:a.email||'',recovery_email_1:a.recovery_email_1||'',recovery_email_2:a.recovery_email_2||'',recovery_verified:recoveryAdmin(req)});
      }

      if(req.method==='POST'&&p==='/api/admin/otp/request'){
  const x=await body(req),mode=String(x.mode||'').trim(),identifier=String(x.identifier||'').trim().toLowerCase();
  if(!['admin_email','unknown_admin_email'].includes(mode))return send(res,400,{error:'Choose a recovery method'});
  let sql='SELECT id,email,recovery_email_1,recovery_email_2,otp_last_sent_at FROM admin_accounts ORDER BY id LIMIT 1';
  let args=[];
  if(mode==='admin_email'){
    if(!identifier)return send(res,400,{error:'Enter your admin email'});
    sql='SELECT id,email,recovery_email_1,recovery_email_2,otp_last_sent_at FROM admin_accounts WHERE lower(email)=? LIMIT 1';
    args=[identifier];
  }
  const r=await db.execute({sql,args});
  if(!r.rows.length)return send(res,200,{ok:true,message:'If the account details are correct, a 6-digit verification code has been sent.'});
  const a=r.rows[0];
  const destination = mode === 'admin_email'
  ? String(a.email || '').trim().toLowerCase()
  : String(a.recovery_email_1 || a.recovery_email_2 || '').trim().toLowerCase();
  if(!destination)return send(res,503,{error:'No recovery email is configured for this admin account.'});
  if(a.otp_last_sent_at&&Date.now()-new Date(a.otp_last_sent_at).getTime()<60000)return send(res,429,{error:'Please wait 60 seconds before requesting another code.'});
  const challenge=crypto.randomBytes(24).toString('hex'),code=String(crypto.randomInt(100000,1000000));
  await db.execute({sql:`UPDATE admin_accounts SET otp_challenge_hash=?,otp_code_hash=?,otp_expires_at=?,otp_purpose=?,otp_attempts=0,otp_last_sent_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[sig(challenge),sig(`${challenge}:${code}`),new Date(Date.now()+10*60*1000).toISOString(),mode,new Date().toISOString(),Number(a.id)]});
  let delivered=false;
  try{delivered=await sendOtpEmail(destination,code)}catch(e){console.error('OTP email failed:',e.message)}
  if(!delivered){
    if(process.env.NODE_ENV==='production'){
      await db.execute({sql:`UPDATE admin_accounts SET otp_challenge_hash='',otp_code_hash='',otp_expires_at='',otp_purpose='',otp_attempts=0 WHERE id=?`,args:[Number(a.id)]});
      return send(res,503,{error:'Verification email is not configured. Please configure SMTP before using account recovery.'});
    }
    console.log(`LOCAL ADMIN OTP for ${destination}: ${code}`);
  }
  const masked=destination.replace(/(^.).*(@.*$)/,'$1***$2');
  return send(res,200,{ok:true,challenge,message:`A 6-digit verification code has been sent to ${masked}. It expires in 10 minutes.`});
}

      if(req.method==='POST'&&p==='/api/admin/otp/verify'){
        const x=await body(req),challenge=String(x.challenge||'').trim(),code=String(x.code||'').replace(/\D/g,'');
        if(!challenge||!/^[0-9]{6}$/.test(code))return send(res,400,{error:'Enter the 6-digit verification code'});
        const r=await db.execute({sql:`SELECT id,email,otp_code_hash,otp_expires_at,otp_attempts FROM admin_accounts WHERE otp_challenge_hash=? LIMIT 1`,args:[sig(challenge)]});
        if(!r.rows.length)return send(res,400,{error:'Verification code is invalid or expired'});
        const a=r.rows[0];
        if(Number(a.otp_attempts||0)>=5)return send(res,429,{error:'Too many incorrect attempts. Request a new verification code.'});
        if(!a.otp_expires_at||new Date(a.otp_expires_at).getTime()<=Date.now())return send(res,400,{error:'Verification code has expired. Request a new code.'});
        if(!safeEqual(a.otp_code_hash,sig(`${challenge}:${code}`))){
          await db.execute({sql:'UPDATE admin_accounts SET otp_attempts=otp_attempts+1 WHERE id=?',args:[Number(a.id)]});
          return send(res,401,{error:'Incorrect verification code'});
        }
        await db.execute({sql:`UPDATE admin_accounts SET otp_challenge_hash='',otp_code_hash='',otp_expires_at='',otp_purpose='',otp_attempts=0,otp_last_sent_at='',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[Number(a.id)]});
        return createAdminSession(res,a.email,true);
      }

            if(req.method==='POST'&&p==='/api/admin/password-reset'){
        if(!need(req,res)||!recoveryAdmin(req))return;
        const x=await body(req),np=String(x.new_password||'');
        if(np.length<8)return send(res,400,{error:'New password must be at least 8 characters'});
        const r=await db.execute('SELECT id FROM admin_accounts ORDER BY id LIMIT 1'),a=r.rows[0];
        if(!a)return send(res,404,{error:'Admin account not found'});
        await db.execute({
          sql:'UPDATE admin_accounts SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
          args:[await bcrypt.hash(np,12),Number(a.id)]
        });
        return send(res,200,{ok:true,password_changed:true});
      }

      if(req.method==='GET'&&p==='/api/admin/settings'){
        if(!need(req,res))return;const r=await db.execute('SELECT email,recovery_email_1,recovery_email_2 FROM admin_accounts ORDER BY id LIMIT 1');const row=r.rows[0]||{};row.recovery_verified=recoveryAdmin(req);return send(res,200,row);
      }
      if(req.method==='PATCH'&&p==='/api/admin/settings'){
        if(!need(req,res))return;
        const x=await body(req),r=await db.execute('SELECT id,password_hash FROM admin_accounts ORDER BY id LIMIT 1'),a=r.rows[0],np=String(x.new_password||'');
        const recovered=recoveryAdmin(req);
        if(np){
          if(np.length<8)return send(res,400,{error:'New password must be at least 8 characters'});
          if(!recovered && !(await bcrypt.compare(String(x.current_password||''),a.password_hash)))return send(res,401,{error:'Current password is incorrect'});
        }
        await db.execute({sql:`UPDATE admin_accounts SET email=?,recovery_email_1=?,recovery_email_2=?,password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[String(x.email||'').trim().toLowerCase(),String(x.recovery_email_1||'').trim().toLowerCase(),String(x.recovery_email_2||'').trim().toLowerCase(),np?await bcrypt.hash(np,12):a.password_hash,Number(a.id)]});
        // Keep the verified recovery state for this authenticated admin
        // session. The state is cleared only by explicit logout, so a user
        // who entered through OTP recovery is not asked for the old password
        // again during the same recovery session.
        return send(res,200,{ok:true,password_changed:!!np,recovery_verified:recovered});
      }

      if (p.startsWith('/api/admin/')) {
        if (!need(req, res)) return;

        const parts = p.split('/').filter(Boolean);
        const type = parts[2];
        const id = parts[3] ? Number(parts[3]) : null;

        if(req.method==='GET' && type==='product-units'){
          const r=await db.execute('SELECT id,name FROM product_units ORDER BY sort_order,id');
          return send(res,200,r.rows.map(x=>({id:Number(x.id),name:String(x.name||'')})));
        }
        if(req.method==='POST' && type==='product-units'){
          const x=await body(req),name=String(x.name||'').trim();
          if(!name)return send(res,400,{error:'Unit name is required'});
          if(name.length>20)return send(res,400,{error:'Unit name must be 20 characters or fewer'});
          const existing=await db.execute({sql:'SELECT id,name FROM product_units WHERE lower(name)=lower(?) LIMIT 1',args:[name]});
          if(existing.rows.length)return send(res,200,{id:Number(existing.rows[0].id),name:String(existing.rows[0].name)});
          const next=await db.execute('SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM product_units');
          const r=await db.execute({sql:'INSERT INTO product_units(name,sort_order) VALUES(?,?)',args:[name,Number(next.rows[0]?.next_order)||1]});
          return send(res,200,{id:Number(r.lastInsertRowid),name});
        }

        if (req.method === 'GET' && type === 'quotes') {
          const quotes = await db.execute(`
            SELECT
              qe.id,
              qe.enquiry_no,
              qe.status,
              qe.created_at,
              c.name AS customer_name,
              c.phone,
              c.location,
              qe.additional_requirement
            FROM quote_enquiries qe
            JOIN customers c
              ON c.id = qe.customer_id
            ORDER BY qe.id DESC
          `);

          const result = [];

          for (const q of quotes.rows) {
            const items = await db.execute({
              sql: `
                SELECT
                  qi.id,
                  p.name AS product,
                  b.name AS brand,
                  qi.specification,
                  qi.quantity,
                  qi.unit
                FROM quote_items qi
                JOIN products p
                  ON p.id = qi.product_id
                LEFT JOIN brands b
                  ON b.id = qi.brand_id
                WHERE qi.enquiry_id=?
                ORDER BY qi.id
              `,
              args: [Number(q.id)]
            });

            result.push({
              id: Number(q.id),
              enquiry_no: q.enquiry_no,
              status: q.status,
              created_at: q.created_at,
              customer_name: q.customer_name,
              phone: q.phone,
              location: q.location,
              additional_requirement:
                q.additional_requirement || '',
              items: items.rows
            });
          }

          return send(res, 200, result);
        }
        if (req.method === 'PATCH' && type === 'quotes' && id) {
          const x=await body(req);
          const status=String(x.status||'NEW').toUpperCase();
          if(!['NEW','CONTACTED','QUOTED','CLOSED'].includes(status)) return send(res,400,{error:'Invalid enquiry status'});
          const exists=await db.execute({sql:'SELECT id FROM quote_enquiries WHERE id=? LIMIT 1',args:[id]});
          if(!exists.rows.length)return send(res,404,{error:'Enquiry not found'});
          await db.execute({sql:'UPDATE quote_enquiries SET status=? WHERE id=?',args:[status,id]});
          return send(res,200,{ok:true});
        }
        if (req.method === 'DELETE' && type === 'quotes' && id) {
          const exists=await db.execute({sql:'SELECT id FROM quote_enquiries WHERE id=? LIMIT 1',args:[id]});
          if(!exists.rows.length)return send(res,404,{error:'Enquiry not found'});
          await db.execute({sql:'DELETE FROM quote_items WHERE enquiry_id=?',args:[id]});
          await db.execute({sql:'DELETE FROM quote_enquiries WHERE id=?',args:[id]});
          return send(res,200,{ok:true});
        }

        if (req.method === 'GET' && type === 'enquiries') {
          const r = await db.execute(
            'SELECT * FROM enquiries ORDER BY id DESC'
          );

          return send(res, 200, r.rows);
        }

        if (
          req.method === 'PATCH' &&
          type === 'enquiries' &&
          id
        ) {
          const x = await body(req);

          await db.execute({
            sql: 'UPDATE enquiries SET status=? WHERE id=?',
            args: [String(x.status || 'New'), id]
          });

          return send(res, 200, { ok: true });
        }

        if (
          req.method === 'DELETE' &&
          type === 'enquiries' &&
          id
        ) {
          await db.execute({
            sql: 'DELETE FROM enquiries WHERE id=?',
            args: [id]
          });

          return send(res, 200, { ok: true });
        }

        if(req.method==='POST'&&type==='products'){
          const x=await body(req),name=String(x.name||'').trim();if(!name)return send(res,400,{error:'Product name is required'});
          const next=await appendPriority('products');
          const r=await db.execute({sql:`INSERT INTO products(name,category,brands,description,available,sort_order,visible,default_unit) VALUES(?,?,?,?,?,?,?,?)`,args:[name,name.toUpperCase(),'',String(x.description||'').trim(),1,next,1,'PCS']});await saveProductQuoteConfiguration(Number(r.lastInsertRowid),x.default_unit,x.options);return send(res,200,{id:Number(r.lastInsertRowid),sort_order:next});
        }
        if(req.method==='PUT'&&type==='products'&&id){
          const x=await body(req),name=String(x.name||'').trim();if(!name)return send(res,400,{error:'Product name is required'});
          const requested=Math.max(1,Number(x.sort_order)||1);
          await movePriority('products',id,requested);
          const current=await db.execute({sql:'SELECT sort_order FROM products WHERE id=?',args:[id]});
          await db.execute({sql:'UPDATE products SET name=?,description=? WHERE id=?',args:[name,String(x.description||'').trim(),id]});
          await saveProductQuoteConfiguration(id,x.default_unit,x.options);
          return send(res,200,{ok:true,sort_order:Number(current.rows[0]?.sort_order)||requested});
        }
        if(req.method==='DELETE'&&type==='products'&&id){
          const used=await db.execute('SELECT COUNT(*) AS count FROM brands WHERE product_id=?',[id]);if(Number(used.rows[0].count)>0)return send(res,409,{error:'This product has brands assigned to it. Reassign or delete those brands first.'});
          const existing=await db.execute('SELECT sort_order FROM products WHERE id=?',[id]);
          await db.execute('DELETE FROM products WHERE id=?',[id]);
          if(existing.rows.length){ const removed=Number(existing.rows[0].sort_order); await db.execute({sql:'UPDATE products SET sort_order=sort_order-1 WHERE sort_order>?',args:[removed]}); }
          await normalizePriorities('products');
          return send(res,200,{ok:true});
        }
        if(req.method==='POST'&&type==='brands'){
          let x={},files=[];const ct=String(req.headers['content-type']||'');if(ct.toLowerCase().startsWith('multipart/form-data')){const q=parseMultipart(await readRaw(req),ct);x=q.fields;files=q.files}else x=await body(req);
          const name=String(x.name||'').trim(),productId=Number(x.product_id);if(!name||!Number.isInteger(productId)||productId<=0)return send(res,400,{error:'Brand name and product are required'});
          const pr=await db.execute('SELECT id FROM products WHERE id=? LIMIT 1',[productId]);if(!pr.rows.length)return send(res,400,{error:'Selected product does not exist'});
          let logo=String(x.logo||'');const lf=files.find(f=>f.field==='logo');if(lf)logo=await saveUploadedImage(lf,'brands',name);
          const r=await db.execute({sql:`INSERT INTO brands(name,category,description,accent,logo,sort_order,product_id,variety,product_image,visible) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[name,'',String(x.description||'').trim(),'#087fe3',logo,0,productId,'','',1]});
          const brandId=Number(r.lastInsertRowid);
          await saveBrandVarieties(brandId,name,x.varieties,files);
          return send(res,200,{id:brandId});
        }
        if(req.method==='PUT'&&type==='brands'&&id){
          let x={},files=[];const ct=String(req.headers['content-type']||'');if(ct.toLowerCase().startsWith('multipart/form-data')){const q=parseMultipart(await readRaw(req),ct);x=q.fields;files=q.files}else x=await body(req);
          const name=String(x.name||'').trim(),productId=Number(x.product_id);if(!name||!Number.isInteger(productId)||productId<=0)return send(res,400,{error:'Brand name and product are required'});
          const pr=await db.execute('SELECT id FROM products WHERE id=? LIMIT 1',[productId]);if(!pr.rows.length)return send(res,400,{error:'Selected product does not exist'});
          const existing=await db.execute({sql:'SELECT logo FROM brands WHERE id=? LIMIT 1',args:[id]});if(!existing.rows.length)return send(res,404,{error:'Brand not found'});
          let logo=String(x.logo||existing.rows[0].logo||'');const lf=files.find(f=>f.field==='logo');if(lf)logo=await saveUploadedImage(lf,'brands',name);
          await db.execute({sql:`UPDATE brands SET name=?,category=?,description=?,accent=?,logo=?,product_id=?,variety='',product_image='',visible=? WHERE id=?`,args:[name,'',String(x.description||'').trim(),'#087fe3',logo,productId,x.visible===undefined?1:(Number(x.visible)?1:0),id]});
          await saveBrandVarieties(Number(id),name,x.varieties,files);
          return send(res,200,{ok:true});
        }
        if(req.method==='DELETE'&&type==='brands'&&id){await db.execute('DELETE FROM brand_varieties WHERE brand_id=?',[id]);await db.execute('DELETE FROM brands WHERE id=?',[id]);return send(res,200,{ok:true});}

        return send(res, 404, {
          error: 'Not found'
        });
      }

      if (req.method === 'GET' && p === '/sitemap.xml') {
        const sitemapXml = await productPageSitemapXml();

        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'no-cache'
        });

        return res.end(sitemapXml);
      }
      if (req.method === 'GET' && p === '/products') {
        return send(res, 404, 'Product not found');
      }

      if (req.method === 'GET' && p.startsWith('/products/')) {
        const productPathParts = p
          .replace(/^\/products\//, '')
          .split('/')
          .filter(Boolean)
          .map(decodeURIComponent);

        const productPageData = await findProductPageData(productPathParts);

        if (!productPageData) {
          return send(res, 404, 'Product not found');
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });

        return res.end(renderProductPage(productPageData, req));
      }

      if (req.method === 'GET') {
        if (p === '/admin') {
          return staticFile(
            res,
            path.join(PUBLIC, 'admin.html')
          );
        }

        const file = path.normalize(
          path.join(
            PUBLIC,
            p === '/' ? 'index.html' : p
          )
        );

        if (!file.startsWith(PUBLIC)) {
          return send(res, 403, 'Forbidden');
        }

        return staticFile(res, file);
      }

      send(res, 404, {
        error: 'Not found'
      });

    } catch (e) {
      console.error(e);
      send(res, 500, {
        error: 'Server error'
      });
    }
  });

  server.listen(PORT, () => {
    console.log(
      `Shree Steel Turso test server: http://localhost:${PORT}`
    );
  });
}

startServer().catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});

