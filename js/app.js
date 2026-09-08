/* =====================================================================
   Облік відвідування дітей у ЗДО — Шаргородська громада
   Автор системи: Стратій Олександр Григорович, Слободо-Шаргородський ліцей
   ===================================================================== */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- Довідники ---------- */
const FORMS = ["очна", "дистанційна", "педагогічний патронаж", "сімейна"];
const STATUSES_REF = ["з інвалідністю","із багатодітної родини","із малозабезпеченої сім'ї",
  "позбавлена батьківської опіки","з неповної сім'ї",
  "постраждала внаслідок воєнних дій та збройних конфліктів","із ЗПО","із ВПО",
  "з особливими освітніми потребами","дитина війни","УБД","мобілізовані"];
const GROUPS_HINT = ["молодша","середня","старша","різновікова"];
const MARK = {N:"н", H:"хв", K:"кор", V:"виб"};
const MARK_FULL = {P:"Присутній", N:"Відсутній", H:"Хворіє", K:"За кордоном"};

/* ---------- Стан ---------- */
const S = {
  profile:null, institutions:[], years:[], yearId:null,
  instId:null, children:[], marks:{}, holidays:new Set(), confirmed:false,
  tab:"today", curDate:todayISO(), vy:null, vm:null,
  search:"", groupFilter:"", sortKey:"group", sortDir:1,
  community:null, summary:null, busy:false, keepScroll:false
};

/* ---------- Дрібні хелпери ---------- */
function todayISO(){ return iso(new Date()) }
function iso(d){ return new Date(d.getTime() - d.getTimezoneOffset()*6e4).toISOString().slice(0,10) }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])) }
function fmtLong(s){ return new Date(s).toLocaleDateString("uk-UA",{day:"numeric",month:"long",weekday:"long"}) }
function fmtShort(s){ return new Date(s).toLocaleDateString("uk-UA") }
function monthName(y,m){ return new Date(y,m,1).toLocaleDateString("uk-UA",{month:"long",year:"numeric"}) }
function isWeekend(s){ const w = new Date(s).getDay(); return w===0 || w===6 }
function isWork(s){ return !isWeekend(s) && !S.holidays.has(s) }
function workDays(y,m){
  const out=[], d=new Date(y,m,1);
  while(d.getMonth()===m){ const s=iso(new Date(d)); if(isWork(s)) out.push(s); d.setDate(d.getDate()+1) }
  return out;
}
function isAdmin(){ return S.profile && S.profile.role === "admin" }
function ro(){ return isAdmin() }               // відділ освіти — лише перегляд
function el(id){ return document.getElementById(id) }

let toastTimer;
function toast(msg, bad){
  const t = el("toast");
  t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove("on"), bad ? 3500 : 1200);
}
function fail(e){ console.error(e); toast(e?.message || "Помилка з'єднання з базою", true) }

/* =====================================================================
   Авторизація
   ===================================================================== */
el("loginForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const btn = el("loginBtn"), errBox = el("loginErr");
  const login = el("lg").value.trim().toLowerCase();
  const pass  = el("pw").value;
  if(!login || !pass) return;
  btn.disabled = true; btn.textContent = "Заходимо…"; errBox.classList.add("hidden");
  const email = login.includes("@") ? login : `${login}@${LOGIN_DOMAIN}`;
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = "Увійти";
  if(error){
    errBox.textContent = "Невірний логін або пароль";
    errBox.classList.remove("hidden");
    return;
  }
  el("pw").value = "";
  await start();
});

el("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

el("yearSel").addEventListener("change", ev => {
  const v = ev.target.value;
  if(v === "__new"){ renderYears(); newYearDialog(); return }
  S.yearId = +v;
  const y = curYear();
  const st = new Date(y.starts_on);
  S.vy = st.getFullYear(); S.vm = st.getMonth();
  if(S.curDate < y.starts_on || S.curDate > y.ends_on) S.curDate = y.starts_on;
  reload();
});

/* =====================================================================
   Завантаження даних
   ===================================================================== */
async function start(){
  el("boot").classList.remove("hidden");
  try{
    const { data:{ user } } = await sb.auth.getUser();
    if(!user){ showLogin(); return }

    const [prof, inst, years, hol] = await Promise.all([
      sb.from("profiles").select("*").eq("id", user.id).single(),
      sb.from("institutions").select("*").order("id"),
      sb.from("school_years").select("*").order("starts_on"),
      sb.from("non_working_days").select("day")
    ]);
    if(prof.error) throw prof.error;

    S.profile = prof.data;
    S.institutions = inst.data || [];
    S.years = years.data || [];
    S.holidays = new Set((hol.data || []).map(r => r.day));

    const cur = S.years.find(y => y.is_current) || S.years[S.years.length-1];
    S.yearId = cur ? cur.id : null;

    S.instId = S.profile.institution_id || (S.institutions[0] && S.institutions[0].id);
    const d = new Date(S.curDate);
    S.vy = d.getFullYear(); S.vm = d.getMonth();
    S.tab = isAdmin() ? "community" : "today";

    el("login").classList.add("hidden");
    el("app").classList.remove("hidden");
    el("whoName").textContent = isAdmin() ? "Відділ освіти" : instName(S.instId);
    el("whoRole").textContent = isAdmin() ? "Шаргородська громада · перегляд" : "Вихователь";
    renderYears(); renderTabs();
    await reload();
  }catch(e){ fail(e); showLogin() }
  finally{ el("boot").classList.add("hidden") }
}

function showLogin(){
  el("boot").classList.add("hidden");
  el("app").classList.add("hidden");
  el("login").classList.remove("hidden");
}
function instName(id){ const i = S.institutions.find(x => x.id === id); return i ? i.name : "—" }
function curYear(){ return S.years.find(y => y.id === S.yearId) || S.years[0] }

/* Завантажує все потрібне для поточної вкладки */
async function reload(){
  S.busy = true; render();
  try{
    if(S.tab === "community"){
      const { data, error } = await sb.rpc("community_day", { p_day: S.curDate });
      if(error) throw error;
      S.community = data || [];
    } else if(S.tab === "summary"){
      const days = workDays(S.vy, S.vm);
      const { data, error } = await sb.rpc("community_period",
        { p_from: days[0] || iso(new Date(S.vy,S.vm,1)), p_to: days[days.length-1] || iso(new Date(S.vy,S.vm+1,0)) });
      if(error) throw error;
      S.summary = data || [];
    } else {
      await loadChildren();
      await loadMonth();
      if(S.tab === "today") await loadConfirmation();
    }
  }catch(e){ fail(e) }
  S.busy = false; render();
}

async function loadChildren(){
  const { data, error } = await sb.from("children").select("*")
    .eq("institution_id", S.instId).order("full_name");
  if(error) throw error;
  S.children = data || [];
}

async function loadMonth(){
  const from = iso(new Date(S.vy, S.vm, 1)), to = iso(new Date(S.vy, S.vm+1, 0));
  const lo = S.curDate < from ? S.curDate : from, hi = S.curDate > to ? S.curDate : to;
  const { data, error } = await sb.from("attendance").select("child_id,day,mark")
    .eq("institution_id", S.instId).gte("day", lo).lte("day", hi);
  if(error) throw error;
  S.marks = {};
  (data || []).forEach(r => S.marks[r.child_id + "|" + r.day] = r.mark);
}

async function loadConfirmation(){
  const { data } = await sb.from("day_confirmations").select("day")
    .eq("institution_id", S.instId).eq("day", S.curDate).maybeSingle();
  S.confirmed = !!data;
}

/* =====================================================================
   Позначки
   ===================================================================== */
function markOf(c, day){
  if(c.enrolled_on && day < c.enrolled_on) return "X";   // ще не зарахована
  if(c.left_on && day > c.left_on) return "V";           // вибула
  return S.marks[c.id + "|" + day] || "P";
}
function inList(c, day){ const m = markOf(c, day); return m !== "X" && m !== "V" }

async function setMark(childId, day, mark){
  const key = childId + "|" + day;
  const prev = S.marks[key];
  if(mark === "P") delete S.marks[key]; else S.marks[key] = mark;
  rerender();
  try{
    if(mark === "P"){
      const { error } = await sb.from("attendance").delete().eq("child_id", childId).eq("day", day);
      if(error) throw error;
    }else{
      const { error } = await sb.from("attendance")
        .upsert({ child_id: childId, day, mark }, { onConflict: "child_id,day" });
      if(error) throw error;
    }
    S.confirmed = false;
    toast("Збережено");
  }catch(e){
    if(prev) S.marks[key] = prev; else delete S.marks[key];
    rerender(); fail(e);
  }
}

async function confirmDay(){
  try{
    const { error } = await sb.from("day_confirmations")
      .upsert({ institution_id: S.instId, day: S.curDate, confirmed_at: new Date().toISOString() },
              { onConflict: "institution_id,day" });
    if(error) throw error;
    S.confirmed = true; rerender(); toast("День підтверджено");
  }catch(e){ fail(e) }
}

/* =====================================================================
   Редагування карток дітей (без перемальовування — курсор не стрибає)
   ===================================================================== */
const saveTimers = {};
function editChild(id, field, value){
  const c = S.children.find(x => x.id === id);
  if(!c) return;
  c[field] = value;
  const key = id + "|" + field;
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(async () => {
    try{
      const payload = {};
      payload[field] = (field === "birth_date" || field === "left_on" || field === "enrolled_on")
        ? (value || null) : value;
      const { error } = await sb.from("children").update(payload).eq("id", id);
      if(error) throw error;
      toast("Збережено");
    }catch(e){ fail(e) }
  }, 700);
}

async function addChild(pos){
  try{
    const { data, error } = await sb.from("children").insert({
      institution_id: S.instId, full_name: "", group_name: S.groupFilter || "",
      edu_form: "очна", enrolled_on: todayISO()
    }).select().single();
    if(error) throw error;
    S.children.push(data);
    S.sortKey = "manual";
    rerender();
    const inputs = document.querySelectorAll("table.edit td.name input");
    const target = pos === "top" ? inputs[0] : inputs[inputs.length-1];
    if(target){ target.focus(); target.scrollIntoView({ block:"center" }) }
    toast("Новий рядок");
  }catch(e){ fail(e) }
}

async function deleteChild(id){
  const c = S.children.find(x => x.id === id);
  if(!confirm(`Видалити «${c.full_name || "без імені"}» разом з усім відвідуванням?\nЯкщо дитина просто пішла із садочка — краще поставити дату вибуття.`)) return;
  try{
    const { error } = await sb.from("children").delete().eq("id", id);
    if(error) throw error;
    S.children = S.children.filter(x => x.id !== id);
    rerender(); toast("Видалено");
  }catch(e){ fail(e) }
}

/* =====================================================================
   Навчальні роки
   ===================================================================== */
function renderYears(){
  el("yearSel").innerHTML =
    S.years.map(y => `<option value="${y.id}" ${y.id===S.yearId?"selected":""}>${esc(y.name)} н.р.</option>`).join("")
    + (isAdmin() ? `<option value="__new">+ Новий рік…</option>` : "");
}
function newYearDialog(){
  const y = new Date().getFullYear();
  el("layer").innerHTML = `
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
    <h3>Новий навчальний рік</h3>
    <div class="field"><label>Назва</label><input id="ny_id" value="${y}/${y+1}"></div>
    <div class="field"><label>Початок</label><input id="ny_s" type="date" value="${y}-09-01"></div>
    <div class="field"><label>Кінець</label><input id="ny_e" type="date" value="${y+1}-05-31"></div>
    <p style="font-size:12px;color:var(--ink-soft);margin:10px 0 14px">
      Списки дітей переносити не потрібно: дитина залишається в базі, доки їй не поставлять дату вибуття.
      Відвідування минулих років доступне через цей самий перемикач.</p>
    <button class="btn-main" onclick="saveYear()">Створити рік</button>
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
  </div></div>`;
}
async function saveYear(){
  const name = el("ny_id").value.trim(), starts_on = el("ny_s").value, ends_on = el("ny_e").value;
  if(!name || !starts_on || !ends_on) return toast("Заповніть усі поля", true);
  try{
    await sb.from("school_years").update({ is_current:false }).neq("id", 0);
    const { data, error } = await sb.from("school_years")
      .insert({ name, starts_on, ends_on, is_current:true }).select().single();
    if(error) throw error;
    S.years.push(data); S.yearId = data.id;
    const st = new Date(starts_on); S.vy = st.getFullYear(); S.vm = st.getMonth();
    closeLayer(); renderYears(); reload(); toast("Створено " + name);
  }catch(e){ fail(e) }
}
function closeLayer(){ el("layer").innerHTML = "" }

/* =====================================================================
   Каркас
   ===================================================================== */
function renderTabs(){
  const items = isAdmin()
    ? [["community","Громада"],["month","Місяць"],["kids","Діти"],["report","Звіт закладу"],["summary","Звіт громади"]]
    : [["today","Сьогодні"],["month","Місяць"],["kids","Діти"],["report","Звіти"]];
  el("tabs").innerHTML = items.map(([k,l]) =>
    `<button class="${S.tab===k?"on":""}" onclick="go('${k}')">${l}</button>`).join("");
}
function go(k){ S.tab = k; renderTabs(); window.scrollTo(0,0); reload() }
function pickInst(id){ S.instId = +id; reload() }

function render(){
  const old = document.querySelector(".scroll");
  const sl = old ? old.scrollLeft : 0, st = old ? old.scrollTop : 0, wy = window.scrollY;
  const v = el("view");
  if(S.busy && !S.children.length && !S.community && !S.summary){
    v.innerHTML = `<div class="loading">Завантаження…</div>`;
  }else{
    v.innerHTML =
      S.tab==="today" ? viewToday() : S.tab==="month" ? viewMonth() :
      S.tab==="kids"  ? viewKids()  : S.tab==="report"? viewReport():
      S.tab==="summary"? viewSummary() : viewCommunity();
  }
  const ns = document.querySelector(".scroll");
  if(ns && S.keepScroll){ ns.scrollLeft = sl; ns.scrollTop = st; window.scrollTo(0, wy) }
  S.keepScroll = false;
}
function rerender(){ S.keepScroll = true; render() }

function instPicker(){
  if(!isAdmin()) return "";
  return `<select class="instsel" onchange="pickInst(this.value)">${
    S.institutions.map(i => `<option value="${i.id}" ${i.id===S.instId?"selected":""}>${esc(i.name)}</option>`).join("")}</select>`;
}
function sortedKids(){
  const gi = c => (GROUPS_HINT.indexOf(c.group_name)+1 || 9);
  const by = {
    name:  c => c.full_name || "яяя",
    group: c => String(gi(c)) + "|" + (c.group_name||"") + "|" + (c.full_name||"яяя"),
    birth: c => c.birth_date || "9999-99-99",
    manual:c => String(c.id)
  }[S.sortKey] || (c => c.full_name);
  return [...S.children].sort((a,b) => String(by(a)).localeCompare(String(by(b)), "uk") * S.sortDir);
}
function sortBy(k){ if(S.sortKey===k) S.sortDir = -S.sortDir; else { S.sortKey = k; S.sortDir = 1 } rerender() }

/* =====================================================================
   Вкладка «Сьогодні»
   ===================================================================== */
function viewToday(){
  const list = sortedKids().filter(c => inList(c, S.curDate));
  const cnt = {P:0,N:0,H:0,K:0};
  list.forEach(c => cnt[markOf(c, S.curDate)]++);
  const abs = cnt.N + cnt.H + cnt.K;
  const pct = list.length ? Math.round(cnt.P / list.length * 100) : 0;
  const groups = [...new Set(list.map(c => c.group_name || "без групи"))];
  const holiday = !isWork(S.curDate);
  let n = 0;

  return `${instPicker()}
  <div class="datebar">
    <button class="btn" onclick="shiftDay(-1)" aria-label="Попередній день">‹</button>
    <input type="date" value="${S.curDate}" onchange="setDate(this.value)">
    <button class="btn" onclick="shiftDay(1)" aria-label="Наступний день">›</button>
    <button class="btn" onclick="setDate('${todayISO()}')">Сьогодні</button>
  </div>
  <h2 class="title">${fmtLong(S.curDate)}</h2>
  <p class="note">${holiday
    ? "Неробочий день — відвідування не рахується."
    : "Зелена крапка = дитина в садочку. Позначайте лише тих, кого немає; повторний натиск знімає позначку."}</p>
  <div class="summary">
    <div class="sum ok"><b>${cnt.P}</b><span>присутні</span></div>
    <div class="sum no"><b>${abs}</b><span>відсутні</span></div>
    <div class="sum"><b>${pct}%</b><span>відвідування</span></div>
  </div>
  ${list.length === 0 ? `<div class="card">Список дітей порожній. Перейдіть на вкладку «Діти» і додайте дітей.</div>` : ""}
  ${groups.map(g => {
    const gl = list.filter(c => (c.group_name || "без групи") === g);
    return `<div class="grouprow"><span>Група «${esc(g)}»</span>
      <span>${gl.filter(c => markOf(c,S.curDate)==="P").length} з ${gl.length}</span></div>
      <div class="list">${gl.map(c => {
        const m = markOf(c, S.curDate); n++;
        return `<div class="prow ${m==="P"?"":"m "+m}">
          <span class="num">${n}</span><span class="dot"></span>
          <span class="nm">${esc(c.full_name)}</span>
          <span class="marks">${["N","H","K"].map(k =>
            `<button class="mark" data-s="${k}" aria-pressed="${m===k}"
               aria-label="${esc(c.full_name)}: ${MARK_FULL[k]}"
               ${ro()?"disabled":`onclick="tapMark(${c.id},'${k}')"`}>${MARK[k]}</button>`).join("")}</span>
        </div>`}).join("")}</div>`}).join("")}
  ${ro() || list.length===0 || holiday ? "" : `
  <div class="confirm-box ${S.confirmed?"done":""}">
    <div class="txt">${S.confirmed
      ? "День підтверджено — відділ освіти бачить ваші дані."
      : "Коли всі позначки на місці, підтвердіть день — так відділ освіти бачить, що дані подано."}</div>
    ${S.confirmed ? "" : `<button onclick="confirmDay()">Підтвердити день</button>`}
  </div>`}
  <p class="legend"><i class="N">н</i>відсутній &nbsp; <i class="H">хв</i>хворіє &nbsp;
     <i class="K">кор</i>за кордоном &nbsp; <i class="V">виб</i>вибув — ставиться датою вибуття на вкладці «Діти»</p>`;
}
function tapMark(id, k){
  const c = S.children.find(x => x.id === id);
  setMark(id, S.curDate, markOf(c, S.curDate) === k ? "P" : k);
}
function setDate(v){
  if(!v) return;
  S.curDate = v;
  const d = new Date(v);
  const sameMonth = d.getFullYear() === S.vy && d.getMonth() === S.vm;
  S.vy = d.getFullYear(); S.vm = d.getMonth();
  sameMonth ? (loadConfirmation().then(rerender), rerender()) : reload();
}
function shiftDay(n){ const d = new Date(S.curDate); d.setDate(d.getDate()+n); setDate(iso(d)) }

/* =====================================================================
   Вкладка «Місяць»
   ===================================================================== */
function viewMonth(){
  const days = workDays(S.vy, S.vm);
  const list = sortedKids();
  const rows = list.map((c,i) => {
    const cells = days.map(d => {
      const m = markOf(c, d);
      const clickable = !ro() && m !== "V" && m !== "X";
      return `<td class="cell ${clickable?"":"ro"} ${m==="P"||m==="X"?"":m}"
        ${clickable?`onclick="openPick(event,${c.id},'${d}')"`:""}>${m==="P"||m==="X"?"":MARK[m]}</td>`;
    }).join("");
    return `<tr><td class="num">${i+1}</td><td class="name">${esc(c.full_name)}</td>${cells}</tr>`;
  }).join("");
  const totals = days.map(d => `<td>${list.filter(c => markOf(c,d)==="P").length}</td>`).join("");

  return `${instPicker()}
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)">‹</button>
    <div style="flex:1;text-align:center;font-weight:800;font-size:15px">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)">›</button>
  </div>
  ${ro() ? `<span class="viewonly">Лише перегляд</span>` : ""}
  <p class="note">${ro()
    ? "Відділ освіти дані не змінює."
    : "Натисніть клітинку — і виберіть позначку зі списку. Вихідні та святкові дні у сітці не показуються."}</p>
  ${list.length===0 ? `<div class="card">Список дітей порожній.</div>` : `
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Прізвище, ім'я, по батькові</th>
      ${days.map(d => `<th>${new Date(d).getDate()}</th>`).join("")}</tr></thead>
    <tbody>${rows}
      <tr class="total"><td class="num"></td><td class="name">Присутніх за день</td>${totals}</tr>
    </tbody></table></div>`}
  <p class="legend"><i class="N">н</i>відсутній &nbsp; <i class="H">хв</i>хворіє &nbsp;
     <i class="K">кор</i>за кордоном &nbsp; <i class="V">виб</i>вибув</p>`;
}
function shiftMonth(n){ const d = new Date(S.vy, S.vm + n, 1); S.vy = d.getFullYear(); S.vm = d.getMonth(); reload() }

function openPick(ev, id, day){
  const c = S.children.find(x => x.id === id);
  const m = markOf(c, day);
  const opts = [["P","Присутній"],["N","Відсутній"],["H","Хворіє"],["K","За кордоном"]];
  el("layer").innerHTML = `<div class="backdrop" onclick="closeLayer()"></div>
    <div class="popmenu" id="pm">
      <div class="ph">${esc(c.full_name)}<br>${new Date(day).toLocaleDateString("uk-UA",{day:"numeric",month:"long"})}</div>
      ${opts.map(([k,l]) => `<button onclick="pickMark(${id},'${day}','${k}')">
        <b class="${k}">${k==="P"?"✓":MARK[k]}</b>${l}${m===k?" ✓":""}</button>`).join("")}
    </div>`;
  const pm = el("pm"), r = ev.target.getBoundingClientRect(), h = pm.offsetHeight, w = pm.offsetWidth;
  pm.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  pm.style.top  = (r.bottom + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
}
function pickMark(id, day, k){ closeLayer(); setMark(id, day, k) }

/* =====================================================================
   Вкладка «Діти»
   ===================================================================== */
function viewKids(){
  const all = sortedKids();
  const list = all.filter(c =>
    (!S.groupFilter || (c.group_name||"") === S.groupFilter) &&
    (c.full_name||"").toLowerCase().includes(S.search.toLowerCase()));
  const groups = [...new Set(S.children.map(c => c.group_name).filter(Boolean))];
  const th = (k,l,cls="") => `<th class="${cls} sortable ${S.sortKey===k?"act":""}" onclick="sortBy('${k}')">${l}${
    S.sortKey===k ? (S.sortDir>0?" ↑":" ↓") : ""}</th>`;
  const addRow = pos => ro() ? "" :
    `<tr class="addrow"><td class="num"></td><td class="name" colspan="12">
       <button onclick="addChild('${pos}')">+ Додати дитину</button></td></tr>`;
  const inp = (c, f, attr="") => ro()
    ? `<td>${esc(c[f]||"")}</td>`
    : `<td><input ${attr} value="${esc(c[f]||"")}" oninput="editChild(${c.id},'${f}',this.value)"></td>`;
  const sel = (c, f, arr) => ro()
    ? `<td>${esc(c[f]||"")}</td>`
    : `<td><select onchange="editChild(${c.id},'${f}',this.value)"><option value=""></option>${
        arr.map(o => `<option ${c[f]===o?"selected":""}>${esc(o)}</option>`).join("")}</select></td>`;

  return `${instPicker()}
  <h2 class="title">Діти</h2>
  <p class="note">${all.filter(c => !c.left_on || c.left_on >= S.curDate).length} у списку ·
     ${S.children.filter(c => c.left_on).length} вибуло${ro()?" · лише перегляд":""}.
     Сортування — натисніть на заголовок стовпчика.</p>
  <div class="toolbar">
    <input placeholder="Пошук за прізвищем" value="${esc(S.search)}" oninput="S.search=this.value;rerender()">
    <select onchange="S.groupFilter=this.value;rerender()">
      <option value="">Усі групи</option>
      ${groups.map(g => `<option ${S.groupFilter===g?"selected":""}>${esc(g)}</option>`).join("")}
    </select>
    <button class="btn" onclick="exportKids()">Excel</button>
  </div>
  <datalist id="gr">${GROUPS_HINT.map(g => `<option value="${g}">`).join("")}</datalist>
  <div class="scroll"><table class="edit">
    <thead><tr>
      <th class="num">№</th>
      ${th("name","Прізвище, ім'я, по батькові","name")}
      ${th("group","Група")}
      ${th("birth","Дата народж.")}
      <th style="min-width:200px">Батьки (опікун)</th>
      <th style="min-width:220px">Домашня адреса</th>
      <th style="min-width:130px">Телефон</th>
      <th style="min-width:170px">Форма здобуття</th>
      <th style="min-width:250px">Спеціальний статус</th>
      <th style="min-width:100px">Пільга</th>
      <th style="min-width:130px">Зараховано</th>
      <th style="min-width:130px">Дата вибуття</th>
      <th style="min-width:52px"></th>
    </tr></thead>
    <tbody>
      ${addRow("top")}
      ${list.map((c,i) => `<tr>
        <td class="num">${i+1}</td>
        ${ro() ? `<td class="name">${esc(c.full_name)}</td>`
               : `<td class="name"><input value="${esc(c.full_name)}" oninput="editChild(${c.id},'full_name',this.value)"></td>`}
        ${ro() ? `<td>${esc(c.group_name||"")}</td>`
               : `<td><input list="gr" value="${esc(c.group_name||"")}" oninput="editChild(${c.id},'group_name',this.value)"></td>`}
        ${inp(c,"birth_date",'type="date"')}
        ${inp(c,"parents")}${inp(c,"address")}${inp(c,"phone")}
        ${sel(c,"edu_form",FORMS)}${sel(c,"special_status",STATUSES_REF)}${sel(c,"meal_benefit",["50","100"])}
        ${inp(c,"enrolled_on",'type="date"')}${inp(c,"left_on",'type="date"')}
        <td>${ro()?"":`<button class="mini" onclick="deleteChild(${c.id})">✕</button>`}</td>
      </tr>`).join("")}
      ${addRow("bottom")}
    </tbody></table></div>
  <p class="legend">Зміни зберігаються самі. Дата вибуття закриває дитину: з наступного дня в сітці «виб»,
     історія відвідування зберігається.</p>`;
}

/* =====================================================================
   Звіт закладу
   ===================================================================== */
function monthStats(){
  const days = workDays(S.vy, S.vm).filter(d => d <= todayISO());
  const list = S.children;
  let present = 0, slots = 0, N = 0, H = 0, K = 0;
  days.forEach(d => list.forEach(c => {
    const m = markOf(c, d);
    if(m === "X" || m === "V") return;
    slots++;
    if(m === "P") present++; else if(m === "N") N++; else if(m === "H") H++; else if(m === "K") K++;
  }));
  const act = list.filter(c => (!c.left_on || c.left_on >= S.curDate) && (!c.enrolled_on || c.enrolled_on <= S.curDate));
  const byF = {}, byS = {};
  act.forEach(c => { byF[c.edu_form] = (byF[c.edu_form]||0)+1; if(c.special_status) byS[c.special_status] = (byS[c.special_status]||0)+1 });
  return { days: days.length, pct: slots ? Math.round(present/slots*100) : 0, N, H, K,
    all: list.length, out: list.filter(c => c.left_on).length, act: act.length,
    b50: act.filter(c => c.meal_benefit === "50").length,
    b100: act.filter(c => c.meal_benefit === "100").length, byF, byS };
}
function viewReport(){
  const r = monthStats();
  return `${instPicker()}
  <h2 class="title">Звіт</h2>
  <p class="note">${esc(instName(S.instId))} · ${monthName(S.vy,S.vm)} · ${esc(curYear()?.name||"")} н.р.</p>
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)">‹</button>
    <div style="flex:1;text-align:center;font-weight:700">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)">›</button>
  </div>
  <div class="card"><h3>Кількість дітей</h3>
    <div class="kv"><span>Всього у базі закладу</span><b>${r.all}</b></div>
    <div class="kv"><span>Вибуло</span><b>${r.out}</b></div>
    <div class="kv"><span>Фактично на ${fmtShort(S.curDate)}</span><b>${r.act}</b></div></div>
  <div class="card"><h3>Відвідування за місяць</h3>
    <div class="kv"><span>Середнє відвідування</span><b>${r.pct}%</b></div>
    <div class="kv"><span>Робочих днів пройшло</span><b>${r.days}</b></div>
    <div class="kv"><span>Пропуски: відсутній (н)</span><b>${r.N}</b></div>
    <div class="kv"><span>Пропуски: хворів (хв)</span><b>${r.H}</b></div>
    <div class="kv"><span>Пропуски: за кордоном (кор)</span><b>${r.K}</b></div></div>
  <div class="card"><h3>Форма здобуття дошкільної освіти</h3>
    ${FORMS.map(f => `<div class="kv"><span>${f}</span><b>${r.byF[f]||0}</b></div>`).join("")}</div>
  <div class="card"><h3>Спеціальний статус</h3>
    ${STATUSES_REF.filter(s => r.byS[s]).map(s => `<div class="kv"><span>${s}</span><b>${r.byS[s]}</b></div>`).join("")
      || `<div class="kv"><span>Дітей зі статусом немає</span><b>0</b></div>`}</div>
  <div class="card"><h3>Пільги на харчування</h3>
    <div class="kv"><span>50%</span><b>${r.b50}</b></div>
    <div class="kv"><span>100%</span><b>${r.b100}</b></div></div>
  <button class="btn-main" onclick="exportReport()">Вивантажити в Excel</button>`;
}

/* =====================================================================
   Громада (відділ освіти)
   ===================================================================== */
function viewCommunity(){
  const rows = S.community || [];
  const total = rows.reduce((s,r) => s + Number(r.kids), 0);
  const sent = rows.filter(r => r.confirmed);
  const avg = sent.length
    ? Math.round(sent.reduce((s,r) => s + (r.kids ? r.present/r.kids*100 : 0), 0) / sent.length) : 0;
  return `
  <div class="datebar">
    <button class="btn" onclick="shiftDay(-1)">‹</button>
    <input type="date" value="${S.curDate}" onchange="setDateReload(this.value)">
    <button class="btn" onclick="setDateReload('${todayISO()}')">Сьогодні</button>
  </div>
  <h2 class="title">${fmtLong(S.curDate)}</h2>
  <p class="note">Зведення по всіх закладах громади. Натисніть на заклад, щоб відкрити його сітку за місяць.</p>
  <div class="summary">
    <div class="sum"><b>${total}</b><span>дітей у громаді</span></div>
    <div class="sum ok"><b>${avg}%</b><span>середнє відвідування</span></div>
    <div class="sum no"><b>${rows.length - sent.length}</b><span>не подали</span></div>
  </div>
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Заклад</th><th>Дітей</th><th>Присутні</th><th>%</th><th>Стан</th></tr></thead>
    <tbody>${rows.map((r,i) => {
      const pct = r.kids ? Math.round(r.present / r.kids * 100) : 0;
      return `<tr class="clickable" onclick="openInst(${r.institution_id})">
        <td class="num">${i+1}</td><td class="name">${esc(r.name)}</td><td>${r.kids}</td>
        <td>${r.confirmed ? r.present : "—"}</td>
        <td class="pct ${pct<70?"low":""}">${r.confirmed ? pct+"%" : "—"}</td>
        <td>${r.confirmed ? `<span class="badge-ok">подано</span>` : `<span class="badge-wait">очікуємо</span>`}</td>
      </tr>`}).join("")}</tbody></table></div>`;
}
function setDateReload(v){ if(!v) return; S.curDate = v; const d = new Date(v); S.vy = d.getFullYear(); S.vm = d.getMonth(); reload() }
function openInst(id){ S.instId = id; S.tab = "month"; renderTabs(); window.scrollTo(0,0); reload() }

function viewSummary(){
  const rows = S.summary || [];
  const days = workDays(S.vy, S.vm).filter(d => d <= todayISO()).length;
  const sum = f => rows.reduce((s,r) => s + Number(r[f]), 0);
  const pctOf = r => { const slots = Number(r.kids) * days; return slots ? Math.round((slots - (Number(r.n)+Number(r.h)+Number(r.k)))/slots*100) : 0 };
  const avg = rows.length ? Math.round(rows.reduce((s,r) => s + pctOf(r), 0) / rows.length) : 0;
  return `
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)">‹</button>
    <div style="flex:1;text-align:center;font-weight:800;font-size:15px">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)">›</button>
  </div>
  <h2 class="title">Звіт по громаді</h2>
  <p class="note">${esc(curYear()?.name||"")} н.р. · робочих днів у місяці пройшло: ${days}</p>
  <div class="summary">
    <div class="sum"><b>${sum("kids")}</b><span>дітей</span></div>
    <div class="sum ok"><b>${avg}%</b><span>середнє</span></div>
    <div class="sum no"><b>${sum("n")+sum("h")+sum("k")}</b><span>пропусків</span></div>
  </div>
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Заклад</th><th>Дітей</th><th>%</th>
      <th>н</th><th>хв</th><th>кор</th><th>Пільга 50%</th><th>Пільга 100%</th><th>Вибуло</th></tr></thead>
    <tbody>${rows.map((r,i) => `<tr>
      <td class="num">${i+1}</td><td class="name">${esc(r.name)}</td><td>${r.kids}</td>
      <td class="pct ${pctOf(r)<70?"low":""}">${pctOf(r)}%</td>
      <td>${r.n}</td><td>${r.h}</td><td>${r.k}</td><td>${r.ben50}</td><td>${r.ben100}</td><td>${r.gone}</td>
    </tr>`).join("")}
      <tr class="total"><td class="num"></td><td class="name">Разом</td><td>${sum("kids")}</td><td>${avg}%</td>
        <td>${sum("n")}</td><td>${sum("h")}</td><td>${sum("k")}</td>
        <td>${sum("ben50")}</td><td>${sum("ben100")}</td><td>${sum("gone")}</td></tr>
    </tbody></table></div>
  <button class="btn-main" style="margin-top:11px" onclick="exportSummary()">Вивантажити в Excel</button>`;
}

/* =====================================================================
   Вивантаження (CSV — відкривається в Excel)
   ===================================================================== */
function download(name, rows){
  const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g,'""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type:"text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportKids(){
  const head = ["№","Прізвище, ім'я, по батькові","Група","Дата народження","Батьки","Адреса","Телефон",
    "Форма здобуття","Спеціальний статус","Пільга","Зараховано","Дата вибуття"];
  const rows = sortedKids().map((c,i) => [i+1, c.full_name, c.group_name, c.birth_date, c.parents,
    c.address, c.phone, c.edu_form, c.special_status, c.meal_benefit, c.enrolled_on, c.left_on]);
  download(`dity-${instName(S.instId)}.csv`, [head, ...rows]);
}
function exportReport(){
  const days = workDays(S.vy, S.vm);
  const head = ["№","Прізвище, ім'я, по батькові", ...days.map(d => new Date(d).getDate()), "Присутніх днів"];
  const rows = sortedKids().map((c,i) => {
    const cells = days.map(d => { const m = markOf(c,d); return m==="P"||m==="X" ? "" : MARK[m] });
    return [i+1, c.full_name, ...cells, days.filter(d => markOf(c,d)==="P").length];
  });
  const tot = ["","Присутніх за день", ...days.map(d => S.children.filter(c => markOf(c,d)==="P").length), ""];
  download(`vidviduvannia-${monthName(S.vy,S.vm)}.csv`, [head, ...rows, tot]);
}
function exportSummary(){
  const rows = S.summary || [];
  const head = ["№","Заклад","Дітей","н","хв","кор","Пільга 50%","Пільга 100%","Вибуло"];
  download(`zvit-gromady-${monthName(S.vy,S.vm)}.csv`,
    [head, ...rows.map((r,i) => [i+1, r.name, r.kids, r.n, r.h, r.k, r.ben50, r.ben100, r.gone])]);
}

/* =====================================================================
   Старт
   ===================================================================== */
(async () => {
  const { data:{ session } } = await sb.auth.getSession();
  if(session) await start(); else showLogin();
})();
