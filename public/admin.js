const app=document.getElementById('app');
let tab='products', products=[], brands=[], me=null;
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
async function json(url,opt){const r=await fetch(url,opt);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d}
function modal(title,body){const el=document.createElement('div');el.className='modal show';el.innerHTML=`<div class="modal-card"><div class="modal-head"><h2>${esc(title)}</h2><button class="btn gray" data-close>Close</button></div>${body}</div>`;el.querySelector('[data-close]').onclick=()=>el.remove();document.body.appendChild(el);return el}
function passwordField(id,placeholder,autocomplete){
  return `<div class=\"password-field\"><input id=\"${id}\" type=\"password\" placeholder=\"${placeholder}\" autocomplete=\"${autocomplete}\" required><button type=\"button\" class=\"password-toggle\" data-password-target=\"${id}\" aria-label=\"Show password\" aria-pressed=\"false\">Show</button></div>`;
}
function bindPasswordToggles(root=document){
  root.querySelectorAll('[data-password-target]').forEach(btn=>{
    btn.onclick=()=>{
      const input=root.querySelector('#'+btn.dataset.passwordTarget);
      if(!input)return;
      const showing=input.type==='text';
      input.type=showing?'password':'text';
      btn.textContent=showing?'Show':'Hide';
      btn.setAttribute('aria-label',showing?'Show password':'Hide password');
      btn.setAttribute('aria-pressed',String(!showing));
    };
  });
}
async function start(){
  try{const d=await json('/api/admin/me');d.authenticated?dashboard(d):login()}catch{login()}
}
function login(){
  app.innerHTML=`<div class="login"><img src="/assets/shree-steel-logo.png" alt="Shree Steel"><h1>Admin Login</h1><p class="meta">Manage products, trusted brands and customer enquiries.</p><form id="loginForm" class="form"><input id="email" type="email" placeholder="Admin Email" autocomplete="username" required>${passwordField('password','Password','current-password')}<button class="btn blue">LOGIN</button></form><p style="text-align:center;margin-top:14px"><button class="btn gray" id="forgot">Forgot Password?</button></p><p id="err" class="meta"></p></div>`;
  bindPasswordToggles(app);
  loginForm.onsubmit=async e=>{e.preventDefault();err.textContent='';try{const d=await json('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});dashboard(d)}catch(x){err.textContent=x.message}};
  forgot.onclick=()=>forgotForm();
}
function forgotForm(){
  app.innerHTML=`<div class="login"><img src="/assets/shree-steel-logo.png" alt="Shree Steel"><h1>Account Recovery</h1><p class="meta">Choose how you want to recover your admin account.</p><div class="recovery-choice"><button class="btn gray" id="knowEmail">I Know My Admin Email</button><button class="btn gray" id="forgotEmail">I Don't Know My Admin Email</button></div><p id="msg" class="meta"></p><button class="btn gray" id="back">Back to Login</button></div>`;
  knowEmail.onclick=()=>requestOtpForm('admin_email');
  forgotEmail.onclick=()=>requestOtpForm('unknown_admin_email');
  back.onclick=login;
}

function requestOtpForm(mode){
  const adminMode=mode==='admin_email';

  app.innerHTML=`<div class="login"><img src="/assets/shree-steel-logo.png" alt="Shree Steel"><h1>${adminMode?'Verify Admin Email':'Recover Admin Account'}</h1><p class="meta">${adminMode?'Enter your admin email. A 6-digit verification code will be sent to your configured recovery email.':'You do not need to enter an email. A 6-digit verification code will be sent automatically to your configured recovery email.'}</p>${adminMode?`<form id="otpRequestForm" class="form"><input id="identifier" type="email" placeholder="Admin Email" autocomplete="email" required><button class="btn blue">SEND CODE</button></form>`:`<form id="otpRequestForm" class="form"><button class="btn blue">SEND CODE</button></form>`}<p id="msg" class="meta"></p><button class="btn gray" id="chooseAnother">Choose Another Method</button></div>`;

  chooseAnother.onclick=forgotForm;

  otpRequestForm.onsubmit=async e=>{
    e.preventDefault();
    msg.textContent='Sending verification code...';
    try{
      const d=await json('/api/admin/otp/request',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          mode,
          identifier:adminMode?identifier.value:''
        })
      });
      if(d.challenge)verifyOtpForm(mode,d.challenge,d.message);
      else msg.textContent=d.message||'If the account details are correct, a verification code has been sent.';
    }catch(x){
      msg.textContent=x.message;
    }
  };
}

function verifyOtpForm(mode,challenge,notice){
  app.innerHTML=`<div class="login"><img src="/assets/shree-steel-logo.png" alt="Shree Steel"><h1>Enter Verification Code</h1><p class="meta">${esc(notice||'A 6-digit code has been sent.')}<br>Enter the 6-digit code to continue.</p><form id="verifyForm" class="form"><input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-digit code" required><button class="btn blue">VERIFY CODE</button></form><p id="msg" class="meta"></p><p style="text-align:center"><button class="btn gray" id="resend">Resend Code</button> <button class="btn gray" id="changeMethod">Change Method</button></p></div>`;

  verifyForm.onsubmit=async e=>{
    e.preventDefault();
    msg.textContent='Verifying...';
    try{
      const d=await json('/api/admin/otp/verify',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({challenge,code:otp.value})
      });
      resetPasswordForm(d);
    }catch(x){
      msg.textContent=x.message;
    }
  };

  resend.onclick=()=>requestOtpForm(mode);
  changeMethod.onclick=forgotForm;
}

function resetPasswordForm(info){
  app.innerHTML=`<div class="login"><img src="/assets/shree-steel-logo.png" alt="Shree Steel"><h1>Reset Admin Password</h1><p class="meta">Verification successful. Create a new password for your Admin Account.</p><form id="resetForm" class="form">${passwordField('rnew','New Password','new-password').replace(' required',' minlength="8" required')}${passwordField('rconfirm','Confirm New Password','new-password').replace(' required',' minlength="8" required')}<button class="btn blue">RESET PASSWORD</button></form><p id="msg" class="meta"></p></div>`;

  bindPasswordToggles(document.getElementById('resetForm'));

  resetForm.onsubmit=async e=>{
    e.preventDefault();

    if(rnew.value!==rconfirm.value){
      msg.textContent='New passwords do not match.';
      return;
    }

    try{
      msg.textContent='Saving new password...';

      await json('/api/admin/password-reset',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({new_password:rnew.value})
      });

      msg.textContent='Password reset successfully. Opening Admin Panel...';

      setTimeout(()=>dashboard({...info,recovery_verified:true}),500);
    }catch(x){
      msg.textContent=x.message;
    }
  };
}
function dashboard(info){
  me=info;app.innerHTML=`<header class="top"><div class="brand">SHREE STEEL · ADMIN</div><div class="actions"><button class="btn gray" id="settingsBtn">Admin Account</button><button class="btn gray" id="logout">Logout</button></div></header><main class="wrap"><div class="tabs"><button class="tab active" data-tab="products">Products</button><button class="tab" data-tab="brands">Trusted Brands</button><button class="tab" data-tab="enquiries">Enquiries</button><button class="tab" data-tab="hero">Hero Carousel</button></div><div id="content"></div></main>`;
  document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));render()});
  logout.onclick=async()=>{await json('/api/admin/logout',{method:'POST'});login()};settingsBtn.onclick=settings;render();
}
async function render(){const c=document.getElementById('content');c.innerHTML='<div class="panel">Loading...</div>';try{if(tab==='products')return productsView(c);if(tab==='brands')return brandsView(c);if(tab==='hero')return heroSlidesView(c);return enquiriesView(c)}catch(e){c.innerHTML=`<div class="panel notice">${esc(e.message)}</div>`}}
async function productsView(c){
  products=await json('/api/products');
  c.innerHTML=`<section class="panel"><div class="row" style="border:0;padding-top:0"><div><h2>Products</h2><div class="meta">Products are independent. Brands are categorized under Products from the Trusted Brands section.</div></div><button class="btn blue" id="addProduct">ADD PRODUCT</button></div></section><section class="panel">${products.length?products.map(p=>`<div class="row"><div><b>${esc(p.name)}</b><div class="meta">${esc(p.description)}<br>Priority: ${Number(p.sort_order)||0}</div></div><div class="actions"><button class="btn gray" data-edit="${p.id}">Edit</button><button class="btn danger" data-delete="${p.id}">Delete</button></div></div>`).join(''):'<div class="empty">No products yet.</div>'}</section>`;
  addProduct.onclick=()=>productModal();
  c.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>productModal(Number(b.dataset.edit)));
  c.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this product?'))return;try{await json('/api/admin/products/'+b.dataset.delete,{method:'DELETE'});render()}catch(e){alert(e.message)}});
}
async function productModal(id=null){
  const p=id?products.find(x=>Number(x.id)===id):null;
  const next=products.reduce((m,x)=>Math.max(m,Number(x.sort_order)||0),0)+1;
  const priority=Number(p?.sort_order)||next;
  const specs=(p?.options||[]).map(o=>`${o.name}: ${o.value}`).join('\n');
  const el=modal(p?'Edit Product':'Add Product',`<form id="productForm" class="form"><input id="pname" placeholder="Product Name" value="${esc(p?.name||'')}" required><textarea id="pdesc" placeholder="Description">${esc(p?.description||'')}</textarea><label class="meta">Priority <input id="psort" type="number" min="1" step="1" value="${priority}" required></label><label class="meta">Product Unit <select id="punit"><option value="PCS">PCS</option><option value="BAGS">BAGS</option><option value="KG">KG</option><option value="TON">TON</option><option value="MTR">MTR</option><option value="SQFT">SQFT</option><option value="SQM">SQM</option><option value="LTR">LTR</option><option value="__NEW_UNIT__">+ Add New Unit</option></select></label><input id="pcustomunit" placeholder="Enter new product unit, e.g. BOX, SET, ROD" maxlength="20" value="" style="display:none"><label class="meta">Product Specifications<span class="meta">These are product specifications, not brand varieties. TMT Steel: 8 mm, 10 mm, 12 mm, 16 mm, 20 mm, 25 mm, 32 mm. Cement: 43 Grade, 53 Grade, OPC, PPC, PSC.</span> <textarea id="pspecs" rows="6" placeholder="One per line, e.g. Diameter: 8 mm">${esc(specs)}</textarea></label><div class="meta">Specifications and quantity unit automatically change when the customer selects this Product in the enquiry form.</div><div class="meta">New products are automatically added at the end. Change the priority to move this product and the others will shift automatically.</div><div class="actions"><button class="btn blue">SAVE PRODUCT</button></div><p id="formMsg" class="meta"></p></form>`);
  const knownUnits=new Set(['PCS','BAGS','KG','TON','MTR','SQFT','SQM','LTR']);
  const savedUnit=String(p?.default_unit||'PCS').trim();
  if(knownUnits.has(savedUnit.toUpperCase())){punit.value=savedUnit.toUpperCase();pcustomunit.value='';}
  else if(savedUnit){punit.value='__NEW_UNIT__';pcustomunit.value=savedUnit;}
  else{punit.value='PCS';pcustomunit.value='';}
  punit.onchange=()=>{const isNew=punit.value==='__NEW_UNIT__';pcustomunit.style.display=isNew?'block':'none';if(!isNew)pcustomunit.value='';};
  punit.onchange();
  productForm.onsubmit=async e=>{e.preventDefault();formMsg.textContent='Saving...';const options=pspecs.value.split(/\r?\n/).map(line=>{const i=line.indexOf(':');return i>0?{name:line.slice(0,i).trim()||'Specification',value:line.slice(i+1).trim()}:{name:'Specification',value:line.trim()}}).filter(x=>x.value);const chosenUnit=punit.value==='__NEW_UNIT__'?pcustomunit.value.trim():punit.value;
  if(!chosenUnit){formMsg.textContent='Please enter a product unit.';return;} if(chosenUnit.length>20){formMsg.textContent='Product unit must be 20 characters or fewer.';return;}
  const body={name:pname.value,description:pdesc.value,sort_order:Math.max(1,Number(psort.value)||1),default_unit:chosenUnit,options};try{await json(id?'/api/admin/products/'+id:'/api/admin/products',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});el.remove();render()}catch(x){formMsg.textContent=x.message}};
}
async function heroSlidesView(c){
  const slides=await json('/api/admin/hero-slides');

  c.innerHTML=`
    <section class="panel">
      <div class="row" style="border:0;padding-top:0">
        <div>
          <h2>Hero Carousel</h2>
          <div class="meta">
            Manage the homepage hero carousel. Changes here will appear on the website.
          </div>
        </div>
        <button class="btn blue" id="addHeroSlide">ADD SLIDE</button>
      </div>
    </section>

    <section class="panel">
      ${
        slides.length
        ? slides.map(s=>`
          <div class="row">
            <div class="brand-item">
              ${
                s.image
                ? `<img class="thumb" src="${esc(s.image)}" alt="">`
                : ''
              }
              <div>
                <b>${esc(s.title)}</b>
                <div class="meta">
                  ${esc(s.label)}<br>
                  Priority: ${Number(s.sort_order)||0} ·
                  ${s.visible?'Available':'Unavailable'}
                </div>
                <div class="meta">
                  ${esc(s.description||'')}
                </div>
              </div>
            </div>

            <div class="actions">
              <button class="btn gray" data-edit-hero="${s.id}">
                Edit
              </button>
              <button class="btn danger" data-delete-hero="${s.id}">
                Delete
              </button>
            </div>
          </div>
        `).join('')
        : '<div class="empty">No hero slides yet.</div>'
      }
    </section>
  `;

  addHeroSlide.onclick=()=>heroSlideModal();

  c.querySelectorAll('[data-edit-hero]').forEach(b=>{
    b.onclick=()=>heroSlideModal(Number(b.dataset.editHero));
  });

  c.querySelectorAll('[data-delete-hero]').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm('Delete this hero slide?'))return;

      try{
        await json(
          '/api/admin/hero-slides/'+b.dataset.deleteHero,
          {method:'DELETE'}
        );

        render();
      }catch(e){
        alert(e.message);
      }
    };
  });
}
async function heroSlideModal(id=null){
  const slides=await json('/api/admin/hero-slides');
  const s=id?slides.find(x=>Number(x.id)===id):null;

  const next=slides.reduce(
    (m,x)=>Math.max(m,Number(x.sort_order)||0),
    0
  )+1;

  const priority=Number(s?.sort_order)||next;

  const el=modal(
    s?'Edit Hero Slide':'Add Hero Slide',
    `
    <form id="heroSlideForm" class="form">

      <label class="meta">
        Hero Image
        <input
          id="heroImage"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          ${s?.image?'':'required'}
        >
      </label>

      ${
        s?.image
        ? `
          <div class="meta">
            Current image:
            <a href="${esc(s.image)}" target="_blank">
              View current image
            </a>
          </div>

          <div style="margin:10px 0">
            <img
              src="${esc(s.image)}"
              alt=""
              style="width:100%;max-width:520px;border-radius:12px;display:block"
            >
          </div>
        `
        : ''
      }

      <label class="meta">
        Label
        <input
          id="heroLabel"
          placeholder="01 · DREAM HOMES"
          value="${esc(s?.label||'')}"
          required
        >
      </label>

      <label class="meta">
        Title
        <input
          id="heroTitle"
          placeholder="Building dreams from the foundation up."
          value="${esc(s?.title||'')}"
          required
        >
      </label>

      <label class="meta">
        Description
        <textarea
          id="heroDescription"
          rows="4"
          placeholder="Short description for this slide"
        >${esc(s?.description||'')}</textarea>
      </label>

      <label class="meta">
        Priority
        <input
          id="heroSort"
          type="number"
          min="1"
          step="1"
          value="${priority}"
          required
        >
      </label>

      <label class="meta">
        Availability
        <select id="heroVisible">
          <option value="1" ${
            s?.visible!==false && Number(s?.visible)!==0
            ? 'selected'
            : ''
          }>Available</option>
          <option value="0" ${
            s?.visible===false || Number(s?.visible)===0
            ? 'selected'
            : ''
          }>Unavailable</option>
        </select>
      </label>

      <div class="actions">
        <button class="btn blue">
          ${s?'SAVE CHANGES':'ADD SLIDE'}
        </button>
      </div>

      <p id="formMsg" class="meta"></p>

    </form>
    `
  );

  heroSlideForm.onsubmit=async e=>{
    e.preventDefault();

    formMsg.textContent='Saving...';

    const fd=new FormData();

    fd.append(
      'label',
      heroLabel.value.trim()
    );

    fd.append(
      'title',
      heroTitle.value.trim()
    );

    fd.append(
      'description',
      heroDescription.value.trim()
    );

    fd.append(
      'sort_order',
      Math.max(1,Number(heroSort.value)||1)
    );

    fd.append(
      'visible',
      Number(heroVisible.value)?1:0
    );

    if(heroImage.files[0]){
      fd.append(
        'image',
        heroImage.files[0]
      );
    }

    try{
      await json(
        id
        ? '/api/admin/hero-slides/'+id
        : '/api/admin/hero-slides',
        {
          method:id?'PUT':'POST',
          body:fd
        }
      );

      el.remove();
      render();

    }catch(x){
      formMsg.textContent=x.message;
    }
  };
}
async function brandsView(c){
  [brands,products]=await Promise.all([json('/api/brands'),json('/api/products')]);
  c.innerHTML=`<section class="panel"><div class="row" style="border:0;padding-top:0"><div><h2>Trusted Brands</h2><div class="meta">Every brand belongs to one Product. Add as many brand varieties as needed, with a separate product image for each variety.</div></div><button class="btn blue" id="addBrand">ADD BRAND</button></div></section><section class="panel">${brands.length?brands.map(b=>`<div class="row"><div class="brand-item">${b.logo?`<img class="thumb" src="${esc(b.logo)}" alt="">`:''}<div><b>${esc(b.name)}</b><div class="meta">Product: ${esc(b.product_name||'Unassigned')} · ${Number(b.varieties?.length)||0} variety(ies)<br>${esc(b.description||'')}</div>${b.varieties?.length?`<div class="meta" style="margin-top:6px">${b.varieties.map(v=>`${esc(v.name)} · Priority ${Number(v.sort_order)||0}${v.product_image?' ✓ image':''}`).join(' · ')}</div>`:''}</div></div><div class="actions">${b.varieties?.slice(0,3).map(v=>v.product_image?`<img class="thumb" src="${esc(v.product_image)}" alt="${esc(v.name)}" title="${esc(v.name)}">`:'').join('')||''}<button class="btn gray" data-edit="${b.id}">Edit</button><button class="btn danger" data-delete="${b.id}">Delete</button></div></div>`).join(''):'<div class="empty">No brands yet.</div>'}</section>`;
  addBrand.onclick=()=>brandModal();c.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>brandModal(Number(b.dataset.edit)));c.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this brand?'))return;try{await json('/api/admin/brands/'+b.dataset.delete,{method:'DELETE'});render()}catch(e){alert(e.message)}});
}
function varietyRowHtml(v={},i=0){
  const available=v.visible!==false && Number(v.visible)!==0;
  return `<div class="variety-row" data-variety-row>
    <div class="variety-row-head"><b>Variety ${i+1}</b><button type="button" class="btn gray" data-remove-variety>Remove</button></div>
    <input data-variety-name placeholder="Brand Variety Name (e.g. Powermax)" value="${esc(v.name||'')}">
    <label class="meta">Priority
      <input data-variety-priority type="number" min="1" step="1" value="${Math.max(1,Number(v.sort_order)||i+1)}" required>
    </label>
    <label class="meta">Availability
      <select data-variety-availability>
        <option value="1" ${available?'selected':''}>Available</option>
        <option value="0" ${!available?'selected':''}>Unavailable</option>
      </select>
    </label>
    <label class="meta">Product Image
      <input data-variety-image type="file" accept="image/png,image/jpeg,image/webp,image/gif">
    </label>
    ${v.product_image?`<div class="meta" data-current-image="${esc(v.product_image)}">Current image: <a href="${esc(v.product_image)}" target="_blank">${esc(v.product_image)}</a></div>`:''}
  </div>`;
}
async function brandModal(id=null){
  const b=id?brands.find(x=>Number(x.id)===id):null;
  const options=products.map(p=>`<option value="${p.id}" ${Number(b?.product_id)===Number(p.id)?'selected':''}>${esc(p.name)}</option>`).join('');
  const initial=b?.varieties?.length?b.varieties:[];
  const el=modal(b?'Edit Brand':'Add Trusted Brand',`<form id="brandForm" class="form"><input id="bname" placeholder="Brand Name" value="${esc(b?.name||'')}" required><label class="meta">Product (this brand belongs to)<select id="bproduct" required><option value="">Select Product</option>${options}</select></label>${b?.varieties?.length?'':`<label class="meta">Availability
<select id="bavailability">
<option value="1" ${b?.visible!==false&&Number(b?.visible)!==0?'selected':''}>Available</option>
<option value="0" ${b?.visible===false||Number(b?.visible)===0?'selected':''}>Unavailable</option>
</select>
</label>`}<textarea id="bdesc" placeholder="Brand Description">${esc(b?.description||'')}</textarea><label class="meta">Brand Logo<input id="blogo" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>${b?.logo?`<div class="meta">Current logo: <a href="${esc(b.logo)}" target="_blank">${esc(b.logo)}</a></div>`:''}<div class="meta">Brand order follows the Product order. Brands do not have an independent priority. Use Variety Priority below to control the order of varieties within this brand.</div><div class="variety-section"><div class="variety-section-head"><div><h3>Brand Varieties</h3><div class="meta">Add each variety separately. Each variety has its own priority and product image.</div></div><button type="button" class="btn gray" id="addVariety">+ ADD VARIETY</button></div><div id="varietyList"></div></div><div class="actions"><button class="btn blue">SAVE BRAND</button></div><p id="formMsg" class="meta"></p></form>`);
  const list=el.querySelector('#varietyList');
  const renumberVarieties=()=>list.querySelectorAll('[data-variety-row]').forEach((row,i)=>{row.querySelector('.variety-row-head b').textContent=`Variety ${i+1}`;row.querySelector('[data-variety-priority]').value=i+1});
  const reorderVarietyRows=(changedRow)=>{
    const rows=[...list.querySelectorAll('[data-variety-row]')];
    const requested=Math.max(1,Math.min(Number(changedRow.querySelector('[data-variety-priority]').value)||1,rows.length));
    const current=rows.indexOf(changedRow);
    const remaining=rows.filter(r=>r!==changedRow);
    remaining.splice(requested-1,0,changedRow);
    remaining.forEach(r=>list.appendChild(r));
    renumberVarieties();
  };
  const addRow=v=>{const i=list.querySelectorAll('[data-variety-row]').length;list.insertAdjacentHTML('beforeend',varietyRowHtml(v,i));const row=list.lastElementChild;row.querySelector('[data-remove-variety]').onclick=()=>{row.remove();renumberVarieties()};row.querySelector('[data-variety-priority]').onchange=()=>reorderVarietyRows(row)};
  initial.forEach(v=>addRow(v));
  renumberVarieties();
  addVariety.onclick=()=>addRow({name:'',product_image:'',sort_order:list.querySelectorAll('[data-variety-row]').length+1});
  brandForm.onsubmit=async e=>{e.preventDefault();formMsg.textContent='Saving...';const fd=new FormData();fd.append('name',bname.value);fd.append('product_id',bproduct.value);
if(!b?.varieties?.length)fd.append('visible',Number(el.querySelector('#bavailability')?.value)?1:0);
fd.append('description',bdesc.value);if(blogo.files[0])fd.append('logo',blogo.files[0]);const vars=[];list.querySelectorAll('[data-variety-row]').forEach((row,i)=>{const name=row.querySelector('[data-variety-name]').value.trim();const file=row.querySelector('[data-variety-image]').files[0];const current=row.querySelector('[data-current-image]')?.getAttribute('data-current-image')||'';if(name){const visible=Number(row.querySelector('[data-variety-availability]').value)?1:0;
const item={name,product_image:current,sort_order:i+1,visible};if(file){const field=`variety_image_${i}`;fd.append(field,file);item.fileIndex=i}vars.push(item)}});fd.append('varieties',JSON.stringify(vars));try{await json(id?'/api/admin/brands/'+id:'/api/admin/brands',{method:id?'PUT':'POST',body:fd});el.remove();render()}catch(x){formMsg.textContent=x.message}};
}
async function enquiriesView(c){
  let data=[];try{data=await json('/api/admin/quotes')}catch{try{data=await json('/api/admin/enquiries')}catch{}}
  const statusButtons=x=>[['NEW','New'],['CONTACTED','Contacted'],['QUOTED','Quoted'],['CLOSED','Closed']].map(([s,label])=>`<button type="button" class="btn ${String(x.status||'NEW').toUpperCase()===s?'blue':'gray'}" data-status="${s}" title="Mark enquiry as ${label}">${label}</button>`).join(' ');
  c.innerHTML=`<section class="panel"><h2>Customer Enquiries & Quotes</h2>${data.length?data.map(x=>`<div class="row enquiry-row"><div style="width:100%"><b>${esc(x.enquiry_no||x.name||x.customer_name||'Enquiry')}</b><div class="meta"><strong>Customer:</strong> ${esc(x.customer_name||x.name||'—')} · <strong>Phone:</strong> ${esc(x.phone||'—')} · <strong>Status:</strong> ${esc(x.status||'NEW')}</div><div class="meta"><strong>Location:</strong> ${esc(x.location||'—')}</div><div class="meta"><strong>Additional requirement:</strong> ${esc(x.additional_requirement||x.message||'None')}</div>${Array.isArray(x.items)&&x.items.length?`<div class="enquiry-items"><b>Requirements</b>${x.items.map((it,i)=>`<div class="enquiry-item"><strong>${i+1}. ${esc(it.product||'Product')}</strong>${it.brand?` · Brand: ${esc(it.brand)}`:''}${it.specification?` · Specification: ${esc(it.specification)}`:''} · Quantity: ${esc(it.quantity)} ${esc(it.unit||'')}</div>`).join('')}</div>`:''}<div class="meta"><strong>Received:</strong> ${esc(x.created_at||'')}</div><div class="sales-stage" style="margin-top:12px"><div class="meta"><strong>Sales Stage — click the current stage manually:</strong></div><div class="actions" style="margin-top:6px">${statusButtons(x)}<button class="btn danger" data-del-quote="${x.id}">Delete</button></div></div></div></div>`).join(''):'<div class="empty">No enquiries yet.</div>'}</section>`;
  c.querySelectorAll('[data-status]').forEach(b=>b.onclick=async()=>{const row=b.closest('.enquiry-row');const id=row?.querySelector('[data-del-quote]')?.dataset.delQuote;if(!id)return;try{await json('/api/admin/quotes/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:b.dataset.status})});render()}catch(e){alert(e.message)}});
  c.querySelectorAll('[data-del-quote]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this enquiry and its requirements?'))return;try{await json('/api/admin/quotes/'+b.dataset.delQuote,{method:'DELETE'});render()}catch(e){alert(e.message)}});
}
async function settings(){
  const x=await json('/api/admin/settings');
  const recovery=!!x.recovery_verified;
  const passwordSection=recovery
    ? `<hr><div class="notice"><b>Recovery verified.</b> You can create or change the admin password without entering the old/current password. This remains active until you log out.</div>${passwordField('snew','New Password','new-password').replace(' required',' minlength="8" required')}${passwordField('sconfirm','Confirm New Password','new-password').replace(' required',' minlength="8" required')}`
    : `<hr><div class="meta">Change password (optional)</div>${passwordField('scurrent','Current Password','current-password').replace(' required','')}${passwordField('snew','New Password','new-password').replace(' required',' minlength="8" required')}${passwordField('sconfirm','Confirm New Password','new-password').replace(' required',' minlength="8" required')}`;
  const el=modal('Admin Account & Recovery',`<form id="settingsForm" class="form"><input id="semail" type="email" placeholder="Admin Email" value="${esc(x.email||'')}" required><input id="sr1" type="email" placeholder="Recovery Email 1" value="${esc(x.recovery_email_1||'')}"><input id="sr2" type="email" placeholder="Recovery Email 2" value="${esc(x.recovery_email_2||'')}">${passwordSection}<button class="btn blue">SAVE ACCOUNT</button><p id="sm" class="meta"></p></form>`);
  bindPasswordToggles(el);
  settingsForm.onsubmit=async e=>{e.preventDefault();if(snew.value&&snew.value!==sconfirm.value){sm.textContent='New passwords do not match.';return}try{await json('/api/admin/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:semail.value,recovery_email_1:sr1.value,recovery_email_2:sr2.value,current_password:recovery?'':(scurrent?.value||''),new_password:snew.value})});sm.textContent=snew.value?'Password and account details saved.':'Account details saved.';me.email=semail.value;if(snew.value){me.recovery_verified=false}}catch(q){sm.textContent=q.message}};
}
start();
