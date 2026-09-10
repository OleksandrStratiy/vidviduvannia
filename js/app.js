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
/* Поля, які імпорт доповнює в наявних дітей, якщо в базі вони порожні */
const FILL_FIELDS = ["group_name","birth_date","parents","address","phone",
  "special_status","meal_benefit","enrolled_on","left_on"];

/* ---------- Стан ---------- */
const S = {
  profile:null, institutions:[], years:[], yearId:null,
  instId:null, children:[], marks:{}, holidays:new Set(), holidayTitles:{},
  gorder:new Map(),  // власний порядок груп закладу: ключ групи → місце
  gorderReady:false, // чи є в базі таблиця group_order (sql/09)
  tab:"today", curDate:todayISO(), vy:null, vm:null,
  search:"", groupFilter:"", sortKey:"group", sortDir:1,
  community:null, summary:null, busy:false, keepScroll:false, saving:false,
  flash:new Set(),   // щойно змінені діти — підсвічуються зеленим
  open:{},           // розгорнуті групи на «Сьогодні»: instId → Set ключів
  sel:null           // режим вибору на «Діти»: Set id або null
};

/* Обробники в розмітці отримують значення через ці масиви, а не через текст,
   вставлений у onclick, — тож назва групи з лапками нічого не зламає. */
let RV = [], RL = [];
const rv = v => RV.push(v) - 1;   // основна сторінка (скидається при кожному рендері)
const rl = v => RL.push(v) - 1;   // вікна поверх сторінки

/* ---------- Дрібні хелпери ---------- */
function todayISO(){ return iso(new Date()) }
function iso(d){ return new Date(d.getTime() - d.getTimezoneOffset()*6e4).toISOString().slice(0,10) }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])) }
function tidy(s){ return String(s ?? "").replace(/\s+/g, " ").trim() }
function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s }
function plural(n, one, few, many){
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
function kidsWord(n){ return n + " " + plural(n, "дитина", "дитини", "дітей") }
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
function toast(msg, bad, ms){
  const t = el("toast");
  t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove("on"), ms || (bad ? 3500 : 1400));
}
function fail(e){ console.error(e); toast(e?.message || "Помилка з'єднання з базою", true) }
function openLayer(html){ el("layer").innerHTML = html }
function closeLayer(){ el("layer").innerHTML = "" }

/* Висота шапки — щоб заголовки груп прилипали точно під нею */
function syncHeader(){
  const h = document.querySelector("header.top");
  if(h && h.offsetHeight) document.documentElement.style.setProperty("--hdr", h.offsetHeight + "px");
}
addEventListener("resize", syncHeader);

/* Excel прибирає нуль на початку номера: 971234567 → 0971234567 */
function fixPhone(p){ p = tidy(p); return /^[1-9]\d{8}$/.test(p) ? "0" + p : p }

/* =====================================================================
   Групи
   Назву групи вписують від руки, тож «Старша», «старша», «Cтарша»
   з латинською C чи «старша - різновікова» з пробілами — це одна група.
   nkey() зводить такі варіанти до одного ключа.
   ===================================================================== */
const LAT = {a:"а",b:"в",c:"с",e:"е",h:"н",i:"і",k:"к",m:"м",o:"о",p:"р",t:"т",x:"х",y:"у"};
const LATCASE = {A:"А",B:"В",C:"С",E:"Е",H:"Н",I:"І",K:"К",M:"М",O:"О",P:"Р",T:"Т",X:"Х",Y:"У",
                 a:"а",c:"с",e:"е",i:"і",o:"о",p:"р",x:"х",y:"у"};
function nkey(s){
  return String(s ?? "").toLowerCase()
    .replace(/[abcehikmoptxy]/g, ch => LAT[ch])
    .replace(/[ʼ’‘'`´]/g, "")
    .replace(/№\s*/g, "№")
    .replace(/[\s\u2010-\u2015-]+/g, " ")
    .trim();
}
/* Охайний вигляд назви: латинські двійники → кирилиця, без пробілів навколо дефіса */
function tidyGroup(s){
  let t = tidy(s);
  if(/[а-яіїєґА-ЯІЇЄҐ]/.test(t)) t = t.replace(/[ABCEHIKMOPTXYaceiopxy]/g, ch => LATCASE[ch]);
  return t.replace(/\s*[\u2010-\u2015-]\s*/g, "-").replace(/№\s+/g, "№");
}
/* Автоматичний порядок (поки заклад не задав свій): раннього віку → І молодша →
   ІІ молодша → середня → старша → різновікова → решта за назвою */
function groupRank(k){
  if(!k) return 99;
  if(/раннь|ясел|ясл/.test(k)) return 0;
  if(/молодш/.test(k)) return /(^| )(іі|2|друга)( |$)/.test(k) ? 2 : /(^| )(і|1|перша)( |$)/.test(k) ? 1 : 2;
  if(/середн/.test(k)) return 3;
  if(/старш/.test(k)) return 4;
  if(/різновік/.test(k)) return 5;
  return 6;
}
function byName(a,b){ return (a.full_name || "").localeCompare(b.full_name || "", "uk") }

/* ключ групи → найуживаніший варіант назви в закладі */
function groupNames(){
  const cnt = new Map();
  S.children.forEach(c => {
    const k = nkey(c.group_name);
    if(!k) return;
    const nm = tidyGroup(c.group_name);
    if(!cnt.has(k)) cnt.set(k, {});
    const o = cnt.get(k); o[nm] = (o[nm] || 0) + 1;
  });
  const out = new Map();
  cnt.forEach((o, k) => out.set(k, Object.keys(o).sort((a,b) => o[b] - o[a] || a.localeCompare(b, "uk"))[0]));
  return out;
}
/* Розкладає список дітей по групах у правильному порядку */
function groupsOf(list){
  const names = groupNames(), m = new Map();
  list.forEach(c => {
    const k = nkey(c.group_name);
    if(!m.has(k)) m.set(k, { key:k, name: k ? (names.get(k) || tidyGroup(c.group_name)) : "", kids:[] });
    m.get(k).kids.push(c);
  });
  const arr = [...m.values()];
  arr.forEach(g => g.kids.sort(byName));
  return arr.sort(cmpGroups);
}
/* Спершу — порядок, заданий закладом у «Налаштуваннях»; групи, яких у ньому
   ще немає, — після них; «без групи» — завжди в самому кінці. */
function cmpGroups(a, b){
  if(!a.key || !b.key) return (a.key ? 0 : 1) - (b.key ? 0 : 1);
  const pa = S.gorder.get(a.key), pb = S.gorder.get(b.key);
  if(pa !== undefined || pb !== undefined){
    if(pa === undefined) return 1;
    if(pb === undefined) return -1;
    if(pa !== pb) return pa - pb;
  }
  return groupRank(a.key) - groupRank(b.key) || a.name.localeCompare(b.name, "uk", {numeric:true});
}
function groupTitle(name){
  if(!name) return "Без групи";
  return /груп/i.test(name) ? cap(name) : `Група «${name}»`;
}
/* Якщо таку групу вже вписано інакше — беремо наявне написання */
function canonGroup(v){
  const k = nkey(v);
  if(!k) return "";
  return groupNames().get(k) || tidyGroup(v);
}
/* Фільтр груп: "" — усі, "~" — діти без групи */
function gfOk(key){ return !S.groupFilter || S.groupFilter === (key || "~") }
function groupSelect(groups){
  if(groups.length < 2 && !S.groupFilter) return "";
  return `<select class="grpsel" aria-label="Група" onchange="setGroupFilter(this.value)">
    <option value="">Усі групи</option>
    ${groups.map(g => { const v = g.key || "~";
      return `<option value="${esc(v)}" ${S.groupFilter===v?"selected":""}>${esc(groupTitle(g.name))} (${g.kids.length})</option>` }).join("")}
  </select>`;
}
function setGroupFilter(v){ S.groupFilter = v; rerender() }

/* =====================================================================
   Авторизація
   ===================================================================== */
/* Мобільні клавіатури люблять підставити велику першу літеру, зайвий пробіл
   або «розумне» тире — через це перша спроба входу зривалась, а друга,
   уже уважніша, проходила. Тому чистимо введене перед відправкою. */
function cleanCredential(v){
  return String(v)
    .replace(/[\u00A0\u2000-\u200B\uFEFF]/g, " ")   // нерозривні та тонкі пробіли
    .replace(/[\u2010-\u2015\u2212]/g, "-")          // «розумні» тире → звичайний дефіс
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")    // «розумні» лапки
    .trim();
}

let loginBusy = false;
el("loginForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  if(loginBusy) return;
  const btn = el("loginBtn"), errBox = el("loginErr");
  const login = cleanCredential(el("lg").value).toLowerCase();
  const pass  = cleanCredential(el("pw").value);
  if(!login || !pass){
    errBox.textContent = "Впишіть логін і пароль";
    errBox.classList.remove("hidden");
    return;
  }
  loginBusy = true;
  btn.disabled = true; btn.textContent = "Заходимо…"; errBox.classList.add("hidden");
  const email = login.includes("@") ? login : `${login}@${LOGIN_DOMAIN}`;

  let error = null;
  try{
    ({ error } = await sb.auth.signInWithPassword({ email, password: pass }));
  }catch(e){ error = e }

  loginBusy = false;
  btn.disabled = false; btn.textContent = "Увійти";

  if(error){
    const msg  = String(error.message || "");
    const code = error.status || error.code || "";
    if(/invalid login credentials|invalid_credentials/i.test(msg) || code === 400){
      errBox.textContent = "Невірний логін або пароль. Перевірте розкладку та великі літери — пароль пишеться малими.";
    }else if(code === 429 || /rate limit|too many/i.test(msg)){
      errBox.textContent = "Забагато спроб поспіль. Зачекайте хвилину і спробуйте ще раз.";
    }else if(/failed to fetch|networkerror/i.test(msg)){
      errBox.textContent = "Немає зв'язку з сервером. Перевірте інтернет і спробуйте ще раз.";
    }else{
      errBox.textContent = "Не вдалося увійти: " + (msg || "невідома помилка");
    }
    errBox.classList.remove("hidden");
    console.error("Помилка входу:", error);
    return;
  }
  el("pw").value = "";
  await start();
});

el("pwEye").addEventListener("click", () => {
  const p = el("pw"), b = el("pwEye"), show = p.type === "password";
  p.type = show ? "text" : "password";
  b.textContent = show ? "Сховати" : "Показати";
  b.setAttribute("aria-label", show ? "Сховати пароль" : "Показати пароль");
  p.focus();
});

el("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

el("yearSel").addEventListener("change", ev => {
  const v = ev.target.value;
  if(v === "__new"){ renderYears(); yearDialog(null); return }
  S.yearId = +v;
  const y = curYear();
  const st = new Date(y.starts_on);
  S.vy = st.getFullYear(); S.vm = st.getMonth();
  if(S.curDate < y.starts_on || S.curDate > yearEnd(y)) S.curDate = y.starts_on;
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

    const [prof, inst] = await Promise.all([
      sb.from("profiles").select("*").eq("id", user.id).single(),
      sb.from("institutions").select("*").order("id")
    ]);
    if(prof.error) throw prof.error;

    S.profile = prof.data;
    S.institutions = inst.data || [];
    S.instId = S.profile.institution_id || (S.institutions[0] && S.institutions[0].id);
    await loadYears();
    await loadHolidays();
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
/* Літо після кінця навчального року (до 31 серпня) теж належить цьому року:
   садочки працюють і влітку, а новий рік починається лише у вересні. */
function yearEnd(y){ const aug = y.ends_on.slice(0,4) + "-08-31"; return y.ends_on > aug ? y.ends_on : aug }

/* Завантажує все потрібне для поточної вкладки */
async function reload(){
  S.busy = true; render();
  try{
    if(S.tab === "settings"){
      await loadYears(); await loadHolidays();
      await loadChildren(); await loadGroupOrder();
    } else if(S.tab === "community"){
      const { data, error } = await sb.rpc("community_day", { p_day: S.curDate });
      if(error) throw error;
      S.community = data || [];
    } else if(S.tab === "summary"){
      /* Межі місяця; робочі дні кожного закладу рахує сама база */
      const { data, error } = await sb.rpc("community_period",
        { p_from: iso(new Date(S.vy, S.vm, 1)), p_to: iso(new Date(S.vy, S.vm+1, 0)) });
      if(error) throw error;
      S.summary = data || [];
    } else {
      if(!S.years.length || S.years[0].institution_id !== S.instId){
        S.yearId = null; await loadYears(); await loadHolidays();
      }
      await loadChildren();
      await loadGroupOrder();
      await loadMonth();
    }
  }catch(e){ fail(e) }
  S.busy = false; render();
}

/* Роки належать конкретному закладу — кожен садочок веде свої */
async function loadYears(){
  const { data, error } = await sb.from("school_years").select("*")
    .eq("institution_id", S.instId).order("starts_on");
  if(error) throw error;
  S.years = data || [];
  const keep = S.years.find(y => y.id === S.yearId);
  const cur  = keep || S.years.find(y => y.is_current) || S.years[S.years.length-1];
  S.yearId = cur ? cur.id : null;
  renderYears();
}

/* Неробочі дні теж належать закладу */
async function loadHolidays(){
  const { data, error } = await sb.from("non_working_days").select("day,title")
    .eq("institution_id", S.instId);
  if(error) throw error;
  S.holidays = new Set((data || []).map(r => r.day));
  S.holidayTitles = {};
  (data || []).forEach(r => S.holidayTitles[r.day] = r.title || "");
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

/* Порядок груп закладу. Якщо таблиці ще немає (не виконано sql/09) —
   просто діє автоматичний порядок, нічого не ламається. */
async function loadGroupOrder(){
  const { data, error } = await sb.from("group_order").select("group_key,pos")
    .eq("institution_id", S.instId);
  S.gorderReady = !error;
  S.gorder = new Map((error ? [] : data || []).map(r => [r.group_key, r.pos]));
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
    toast("Збережено");
  }catch(e){
    if(prev) S.marks[key] = prev; else delete S.marks[key];
    rerender(); fail(e);
  }
}

/* =====================================================================
   Картка дитини — додавання і редагування в одному вікні
   ===================================================================== */
const CHILD_FIELDS = [
  ["full_name",      "Прізвище, ім'я, по батькові", "text",  "Шевчук Марія Іванівна"],
  ["group_name",     "Група",                       "group", "молодша"],
  ["birth_date",     "Дата народження",             "date",  ""],
  ["parents",        "Батьки (опікун)",             "text",  "Шевчук О. П. / Шевчук І. В."],
  ["address",        "Домашня адреса",              "text",  "с. Гибалівка, вул. Шкільна, 5"],
  ["phone",          "Телефон",                     "tel",   "0971234567"],
  ["edu_form",       "Форма здобуття освіти",       "select",FORMS],
  ["special_status", "Спеціальний статус",          "select",STATUSES_REF],
  ["meal_benefit",   "Пільга на харчування",        "select",["50","100"]],
  ["enrolled_on",    "Дата зарахування",            "date",  ""],
  ["left_on",        "Дата вибуття",                "date",  ""]
];

function childDialog(id){
  RL = [];
  const c = id ? S.children.find(x => x.id === id) : null;
  const isNew = !c;
  const y = curYear();
  const defGroup = S.groupFilter && S.groupFilter !== "~" ? (groupNames().get(S.groupFilter) || "") : "";
  const val = f => c ? (c[f] ?? "") : (f === "group_name" ? defGroup : f === "edu_form" ? "очна" : "");
  const chips = list => `<div class="chips">${list.join("")}</div>`;
  const chip = (label, id, v, title) =>
    `<button type="button" class="chip" ${title ? `title="${esc(title)}"` : ""}
       onclick="setField('${id}', RL[${rl(v)}])">${esc(label)}</button>`;

  const fieldHTML = ([f, label, type, extra]) => {
    const v = esc(val(f));
    let input;
    if(type === "select"){
      /* значення, якого немає у списку (напр. з імпорту), не губимо — показуємо окремим пунктом */
      const opts = extra.includes(val(f)) || !val(f) ? extra : [val(f), ...extra];
      input = `<select id="cf_${f}"><option value=""></option>${
        opts.map(o => `<option ${val(f)===o?"selected":""}>${esc(o)}</option>`).join("")}</select>`;
    }else if(type === "group"){
      const names = groupsOf(S.children).filter(g => g.key).map(g => g.name);
      input = `<input id="cf_${f}" autocomplete="off" value="${v}" placeholder="${esc(extra)}">`
        + chips((names.length ? names : GROUPS_HINT).map(g => chip(g, "cf_group_name", g)));
    }else if(type === "date"){
      input = `<input id="cf_${f}" type="date" value="${v}">`;
      if(f === "enrolled_on") input += chips([chip("Сьогодні", "cf_enrolled_on", todayISO()),
        y ? chip("Початок року", "cf_enrolled_on", y.starts_on, fmtShort(y.starts_on)) : ""]);
      if(f === "left_on") input += chips([chip("Сьогодні", "cf_left_on", todayISO()),
        y ? chip("Кінець року", "cf_left_on", y.ends_on, fmtShort(y.ends_on)) : ""]);
    }else{
      input = `<input id="cf_${f}" type="${type}" autocomplete="off" value="${v}" placeholder="${esc(extra)}">`;
    }
    return `<div class="field"><label for="cf_${f}">${label}</label>${input}</div>`;
  };

  openLayer(`
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box wide">
    <h3>${isNew ? "Нова дитина" : "Картка дитини"}</h3>
    ${CHILD_FIELDS.map(fieldHTML).join("")}
    <p class="hint">Дату зарахування можна лишити порожньою, якщо дитина ходить з початку року.
       Дата вибуття — останній день у закладі: з наступного дня в сітці стоїть «виб»,
       а вся історія відвідування зберігається.</p>
    <button class="btn-main" onclick="saveChild(${id || "null"}, false)">Зберегти</button>
    ${isNew ? `<button class="btn" style="width:100%;margin-top:7px" onclick="saveChild(null, true)">Зберегти і додати ще</button>` : ""}
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
    ${isNew ? "" : `<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="deleteChild(${id})">Видалити дитину</button>`}
  </div></div>`);
  setTimeout(() => el("cf_full_name") && el("cf_full_name").focus(), 50);
}

function setField(id, v){
  const f = el(id);
  if(!f) return;
  f.value = v;
  f.focus();
}

function readChildForm(){
  const o = { institution_id: S.instId };
  CHILD_FIELDS.forEach(([f,,type]) => {
    const v = tidy(el("cf_" + f).value);
    o[f] = (type === "date") ? (v || null) : v;
  });
  o.group_name = canonGroup(o.group_name);
  o.phone = fixPhone(o.phone);
  return o;
}

async function saveChild(id, again){
  if(S.saving) return;
  const payload = readChildForm();
  if(!payload.full_name) return toast("Впишіть прізвище та ім'я", true);
  if(payload.enrolled_on && payload.left_on && payload.left_on < payload.enrolled_on)
    return toast("Дата вибуття раніша за дату зарахування", true);
  S.saving = true;
  try{
    if(id){
      const { data, error } = await sb.from("children").update(payload).eq("id", id).select().single();
      if(error) throw error;
      mergeKids([data]);
      S.flash = new Set([id]);
      closeLayer(); rerender(); scrollToFlash();
      warnIfMismatch(payload, data);
    }else{
      const { data, error } = await sb.from("children").insert(payload).select().single();
      if(error) throw error;
      S.children.push(data);
      S.flash = new Set([data.id]);
      warnIfMismatch(payload, data, true);
      if(again){
        /* вікно лишається, група — теж; очищаємо лише дані самої дитини */
        ["full_name","birth_date","parents","address","phone"].forEach(f => el("cf_" + f).value = "");
        rerender();                  // оновлюємо таблицю під вікном, саме вікно не чіпаємо
        el("cf_full_name").focus();
      }else{
        closeLayer(); rerender(); scrollToFlash();
      }
    }
  }catch(e){ fail(e) }
  finally{ S.saving = false }
}

/* Перевіряє, що ім'я і група записались такими, якими їх бачили на екрані */
function warnIfMismatch(sent, saved, isNew){
  const bad = [];
  ["full_name","group_name"].forEach(f => {
    if((sent[f] || "") !== (saved[f] || "")) bad.push(f === "group_name" ? "групу" : "ім'я");
  });
  if(bad.length){
    toast(`Увага: ${bad.join(" і ")} не збереглося — відкрийте картку ще раз і перевірте`, true);
  }else{
    toast(isNew ? "Додано: " + saved.full_name : "Збережено");
  }
}

function mergeKids(rows){
  (rows || []).forEach(r => {
    const i = S.children.findIndex(x => x.id === r.id);
    if(i >= 0) S.children[i] = r; else S.children.push(r);
  });
}
let flashTimer;
function scrollToFlash(){
  const id = [...S.flash][0];
  if(!id) return;
  const row = document.querySelector(`tr[data-child="${id}"]`);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(row) row.scrollIntoView({ block:"center", behavior: calm ? "auto" : "smooth" });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { S.flash = new Set() }, 2500);
}

async function deleteChild(id){
  const c = S.children.find(x => x.id === id);
  if(!confirm(`Видалити «${c?.full_name || "без імені"}» разом з усім відвідуванням?\nЯкщо дитина просто пішла із садочка — краще поставити дату вибуття.`)) return;
  try{
    const { error } = await sb.from("children").delete().eq("id", id);
    if(error) throw error;
    S.children = S.children.filter(x => x.id !== id);
    closeLayer(); rerender(); toast("Видалено");
  }catch(e){ fail(e) }
}

/* =====================================================================
   Імпорт зі списку (CSV з Excel)
   Нових дітей додає, а наявних (збіг за ПІБ) лише доповнює: заповнює
   порожні поля. Нічого не видаляє і заповнених полів не перезаписує,
   тож той самий файл можна завантажити повторно.
   ===================================================================== */
function importDialog(){
  RL = [];
  openLayer(`
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
    <h3>Імпорт списку дітей</h3>
    <p class="hint" style="margin-top:0">Файл CSV у тому самому вигляді, що дає кнопка «Excel».
      Найпростіше: вивантажте шаблон, заповніть в Excel і завантажте назад.</p>
    <button class="btn" style="width:100%;margin-bottom:12px" onclick="downloadTemplate()">Завантажити шаблон</button>
    <div class="field"><label for="imp_file">Заповнений файл (.csv)</label>
      <input id="imp_file" type="file" accept=".csv,text/csv"></div>
    <p id="imp_info" class="hint">
      Діти потрапляють до <b>${esc(instName(S.instId))}</b>. Нові додаються, а в тих, хто вже є
      в списку, заповнюються лише порожні поля. Нічого не видаляється і не перезаписується.</p>
    <button class="btn-main" id="imp_btn" onclick="runImport()">Завантажити</button>
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
  </div></div>`);
}
function downloadTemplate(){
  download("shablon-dity.csv", [
    ["Прізвище, ім'я, по батькові","Група","Дата народження","Батьки","Адреса","Телефон",
     "Форма здобуття","Спеціальний статус","Пільга","Зараховано","Дата вибуття"],
    ["Шевчук Марія Іванівна","молодша","2023-04-15","Шевчук О. П. / Шевчук І. В.",
     "с. Гибалівка, вул. Шкільна, 5","0971234567","очна","із багатодітної родини","50","2026-09-01",""]
  ]);
}
/* Excel в українській Windows зберігає «CSV (розділювач — крапка з комою)»
   у кодуванні Windows-1251, а «CSV UTF-8» — в UTF-8. Приймаємо обидва. */
async function readText(f){
  const buf = await f.arrayBuffer();
  const utf = new TextDecoder("utf-8").decode(buf);
  if(!utf.includes("\uFFFD")) return utf;
  try{ return new TextDecoder("windows-1251").decode(buf) }catch(e){ return utf }
}
/* Розбір CSV: підтримує ; та , як роздільник, лапки, перенос рядків у полі */
function parseCSV(text){
  text = text.replace(/^\uFEFF/, "");
  const head = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const delim = (head.split(";").length > head.split(",").length) ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for(let i = 0; i < text.length; i++){
    const ch = text[i];
    if(q){
      if(ch === '"'){ if(text[i+1] === '"'){ cell += '"'; i++ } else q = false }
      else cell += ch;
    }else{
      if(ch === '"') q = true;
      else if(ch === delim){ row.push(cell); cell = "" }
      else if(ch === "\n"){ row.push(cell); rows.push(row); row = []; cell = "" }
      else if(ch !== "\r") cell += ch;
    }
  }
  if(cell !== "" || row.length){ row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}
/* Шукає стовпчики за заголовками. Стовпчик батьків шукаємо першим і так, щоб
   «Прізвище, ім'я, по батькові» (там теж є «батьк») не сплутати з батьками. */
function mapColumns(headRow){
  const H = headRow.map(h => String(h).toLowerCase().replace(/[ʼ’‘`´]/g, "'").replace(/["\s]/g, ""));
  const used = new Set();
  const pick = test => {
    const i = H.findIndex((h, j) => !used.has(j) && test(h));
    if(i >= 0) used.add(i);
    return i;
  };
  const col = {};
  col.par   = pick(h => /батьк|опікун|мати|матір|матер/.test(h) && !/побатьков/.test(h));
  col.name  = pick(h => /прізвищ|піб|ім'я|імя|имя|фіо|фио/.test(h));
  if(col.name < 0) col.name = pick(h => /дитин/.test(h) && !/народж|дата/.test(h));
  col.birth = pick(h => /народж/.test(h));
  col.group = pick(h => /груп/.test(h));
  col.adr   = pick(h => /адрес/.test(h));
  col.tel   = pick(h => /телеф|^тел/.test(h));
  col.form  = pick(h => /форм|здобут/.test(h));
  col.st    = pick(h => /статус|категор/.test(h));
  col.ben   = pick(h => /пільг/.test(h));
  col.enr   = pick(h => /зарахов/.test(h));
  col.out   = pick(h => /вибут|вибув/.test(h));
  return col;
}
function normDate(v){
  v = String(v || "").trim();
  if(!v) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})$/);   // 05.04.2023 або 05.04.23
  if(m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return null;
}
function normForm(v){ const k = nkey(v); return FORMS.find(f => nkey(f) === k) || "" }
function normStatus(v){ const k = nkey(v); return STATUSES_REF.find(s => nkey(s) === k) || tidy(v) }

async function runImport(){
  const f = el("imp_file").files[0];
  if(!f) return toast("Оберіть файл", true);
  const info = el("imp_info"), btn = el("imp_btn");
  info.style.color = ""; info.textContent = "Читаю файл…"; btn.disabled = true;
  try{
    const rows = parseCSV(await readText(f));
    if(rows.length < 2) throw new Error("У файлі немає рядків з дітьми");
    const col = mapColumns(rows[0]);
    if(col.name < 0) throw new Error("Не знайдено стовпчик з прізвищем та ім'ям дитини");

    const at = (r, i) => i >= 0 ? tidy(r[i]) : "";
    const seen = new Set(), items = [];
    rows.slice(1).forEach(r => {
      const ben = at(r, col.ben).replace(/\D/g, "");
      const p = {
        full_name:  at(r, col.name),
        group_name: canonGroup(at(r, col.group)),
        birth_date: normDate(at(r, col.birth)),
        parents:    at(r, col.par),
        address:    at(r, col.adr),
        phone:      fixPhone(at(r, col.tel)),
        edu_form:   normForm(at(r, col.form)),
        special_status: at(r, col.st) ? normStatus(at(r, col.st)) : "",
        meal_benefit:   ben === "50" || ben === "100" ? ben : "",
        enrolled_on: normDate(at(r, col.enr)),
        left_on:     normDate(at(r, col.out))
      };
      if(!p.full_name) return;
      const key = nkey(p.full_name) + "|" + (p.birth_date || "");
      if(seen.has(key)) return;            // той самий рядок двічі у файлі
      seen.add(key); items.push(p);
    });
    if(!items.length) throw new Error("Жодного рядка з прізвищем не знайдено");

    /* зіставляємо з дітьми, які вже є в закладі */
    const byName = new Map();
    S.children.forEach(c => {
      const k = nkey(c.full_name);
      if(!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    });
    const toAdd = [], toFill = [], unclear = [];
    let same = 0;
    items.forEach(p => {
      const cands = (byName.get(nkey(p.full_name)) || [])
        .filter(c => !p.birth_date || !c.birth_date || c.birth_date === p.birth_date);
      if(cands.length === 0){
        toAdd.push({ institution_id: S.instId, ...p, edu_form: p.edu_form || "очна" });
      }else if(cands.length > 1){
        unclear.push(p.full_name);
      }else{
        const c = cands[0], patch = {};
        FILL_FIELDS.forEach(k => { if(p[k] && !c[k]) patch[k] = p[k] });
        if(Object.keys(patch).length) toFill.push([c.id, patch]); else same++;
      }
    });

    let added = 0, filled = 0;
    if(toAdd.length){
      info.textContent = `Додаю нових: ${toAdd.length}…`;
      const { data, error } = await sb.from("children").insert(toAdd).select();
      if(error) throw error;
      S.children.push(...(data || []));
      added = (data || []).length;
    }
    for(let i = 0; i < toFill.length; i += 8){
      info.textContent = `Доповнюю наявних: ${filled} з ${toFill.length}…`;
      const part = toFill.slice(i, i + 8);
      const res = await Promise.all(part.map(([id, patch]) =>
        sb.from("children").update(patch).eq("id", id).select().single()));
      for(const r of res){ if(r.error) throw r.error; mergeKids([r.data]); filled++ }
    }

    rerender();
    RL = [];
    openLayer(`
    <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
      <h3>Імпорт завершено</h3>
      <div class="kv"><span>Додано нових дітей</span><b>${added}</b></div>
      <div class="kv"><span>Доповнено порожні поля</span><b>${filled}</b></div>
      <div class="kv"><span>Уже були, змін не потрібно</span><b>${same}</b></div>
      ${unclear.length ? `<p class="hint">Не зіставлено, бо в закладі кілька дітей з таким ПІБ:
        <b>${unclear.slice(0, 6).map(esc).join(", ")}${unclear.length > 6 ? " та ще " + (unclear.length - 6) : ""}</b>.
        Їх перевірте вручну.</p>` : ""}
      <button class="btn-main" style="margin-top:12px" onclick="closeLayer()">Готово</button>
    </div></div>`);
  }catch(e){
    info.textContent = "Помилка: " + (e.message || "не вдалося прочитати файл");
    info.style.color = "var(--absent)";
    btn.disabled = false;
  }
}

/* =====================================================================
   Навчальні роки (перемикач у шапці)
   ===================================================================== */
function renderYears(){
  el("yearSel").innerHTML =
    S.years.map(y => `<option value="${y.id}" ${y.id===S.yearId?"selected":""}>${esc(y.name)} н.р.</option>`).join("")
    + (ro() ? "" : `<option value="__new">+ Новий рік…</option>`);
}

/* =====================================================================
   Каркас
   ===================================================================== */
function renderTabs(){
  const items = isAdmin()
    ? [["community","Громада"],["month","Місяць"],["kids","Діти"],["report","Звіт закладу"],["summary","Звіт громади"],["settings","Налаштування"]]
    : [["today","Сьогодні"],["month","Місяць"],["kids","Діти"],["report","Звіти"],["settings","Налаштування"]];
  el("tabs").innerHTML = items.map(([k,l]) =>
    `<button class="${S.tab===k?"on":""}" onclick="go('${k}')">${l}</button>`).join("");
  syncHeader();
}
function go(k){ S.tab = k; S.sel = null; renderTabs(); window.scrollTo(0,0); reload() }
function pickInst(id){
  S.instId = +id; S.yearId = null; S.years = []; S.groupFilter = ""; S.sel = null;
  reload();
}

function render(){
  RV = [];
  const v = el("view");
  const old = v.querySelector(".scroll");
  const sl = old ? old.scrollLeft : 0, st = old ? old.scrollTop : 0, wy = window.scrollY;
  /* поле, в якому зараз курсор, після перемальовування отримує курсор назад —
     інакше пошук губив фокус після кожної літери */
  const ae = document.activeElement;
  const fid = ae && ae.id && v.contains(ae) ? ae.id : null;
  let caret = null;
  try{ if(fid && typeof ae.selectionStart === "number") caret = [ae.selectionStart, ae.selectionEnd] }catch(e){}

  if(S.busy && !S.children.length && !S.community && !S.summary){
    v.innerHTML = `<div class="loading">Завантаження…</div>`;
  }else{
    v.innerHTML =
      S.tab==="today" ? viewToday() : S.tab==="month" ? viewMonth() :
      S.tab==="kids"  ? viewKids()  : S.tab==="report"? viewReport():
      S.tab==="summary"? viewSummary() : S.tab==="settings"? viewSettings() : viewCommunity();
  }
  v.querySelectorAll("input[data-mixed]").forEach(x => x.indeterminate = true);
  document.body.classList.toggle("selecting", !!v.querySelector(".selbar"));

  if(fid){
    const n = el(fid);
    if(n){ n.focus({ preventScroll:true }); try{ if(caret) n.setSelectionRange(caret[0], caret[1]) }catch(e){} }
  }
  /* після ↑/↓ у порядку груп курсор іде за пересунутою групою */
  if(S.focusAfter){
    const [pre, i] = S.focusAfter, n = el(pre + i) || null;
    const alt = el((pre === "gup_" ? "gdn_" : "gup_") + i);
    const t = n && !n.disabled ? n : alt;
    if(t) t.focus({ preventScroll:true });
    S.focusAfter = null;
  }
  const ns = v.querySelector(".scroll");
  if(S.keepScroll){
    if(ns){ ns.scrollLeft = sl; ns.scrollTop = st }
    window.scrollTo(0, wy);
  }
  S.keepScroll = false;
}
function rerender(){ S.keepScroll = true; render() }

function instPicker(){
  if(!isAdmin()) return "";
  return `<select class="instsel" aria-label="Заклад" onchange="pickInst(this.value)">${
    S.institutions.map(i => `<option value="${i.id}" ${i.id===S.instId?"selected":""}>${esc(i.name)}${i.is_demo?" (демо)":""}</option>`).join("")}</select>`;
}
/* Дитина належить навчальному року, якщо її перебування в закладі
   перетинається з проміжком цього року. Вибула торік — у новому році її нема. */
function inYear(c){
  const y = curYear();
  if(!y) return true;
  if(c.enrolled_on && c.enrolled_on > yearEnd(y)) return false;
  if(c.left_on     && c.left_on   < y.starts_on)  return false;
  return true;
}
function yearKids(){ return S.children.filter(inYear) }

function sortedKids(){
  const order = new Map(groupsOf(S.children).map((g,i) => [g.key, i]));
  const cmp = {
    name:  byName,
    group: (a,b) => order.get(nkey(a.group_name)) - order.get(nkey(b.group_name)) || byName(a,b),
    birth: (a,b) => (a.birth_date || "9999").localeCompare(b.birth_date || "9999") || byName(a,b)
  }[S.sortKey] || byName;
  return yearKids().sort((a,b) => cmp(a,b) * S.sortDir);
}
function sortBy(k){ if(S.sortKey===k) S.sortDir = -S.sortDir; else { S.sortKey = k; S.sortDir = 1 } rerender() }

/* =====================================================================
   Вкладка «Сьогодні» — групи згортаються; за замовчуванням відкрита перша.
   Які групи відкриті, пам'ятає кожен пристрій окремо.
   ===================================================================== */
function openSet(groups){
  let st = S.open[S.instId];
  if(!st && groups.length){
    let saved = [];
    try{ saved = JSON.parse(localStorage.getItem("zdo-open-" + S.instId) || "[]") }catch(e){}
    st = new Set((Array.isArray(saved) ? saved : []).filter(k => groups.some(g => g.key === k)));
    if(!st.size) st.add(groups[0].key);
    S.open[S.instId] = st;
  }
  return st || new Set();
}
function saveOpen(){
  try{ localStorage.setItem("zdo-open-" + S.instId, JSON.stringify([...(S.open[S.instId] || [])])) }catch(e){}
}
function toggleGroup(key){
  const st = S.open[S.instId] || (S.open[S.instId] = new Set());
  st.has(key) ? st.delete(key) : st.add(key);
  saveOpen(); rerender();
}
function toggleAllGroups(openAll){
  const groups = groupsOf(yearKids().filter(c => inList(c, S.curDate)));
  S.open[S.instId] = new Set(openAll ? groups.map(g => g.key) : []);
  saveOpen(); rerender();
}

function viewToday(){
  const day = S.curDate;
  const list = yearKids().filter(c => inList(c, day));
  const groups = groupsOf(list);
  const cnt = {P:0,N:0,H:0,K:0};
  list.forEach(c => cnt[markOf(c, day)]++);
  const abs = cnt.N + cnt.H + cnt.K;
  const pct = list.length ? Math.round(cnt.P / list.length * 100) : 0;
  const holiday = !isWork(day);
  const open = openSet(groups);
  const allOpen = groups.length > 0 && groups.every(g => open.has(g.key));

  return `${instPicker()}
  <div class="datebar">
    <button class="btn" onclick="shiftDay(-1)" aria-label="Попередній робочий день">‹</button>
    <input type="date" value="${day}" onchange="setDate(this.value)" aria-label="Дата">
    <button class="btn" onclick="shiftDay(1)" aria-label="Наступний робочий день">›</button>
    <button class="btn" onclick="setDate('${todayISO()}')">Сьогодні</button>
  </div>
  <h2 class="title">${fmtLong(day)}</h2>
  <p class="note">${holiday
    ? "Неробочий день — відвідування не рахується."
    : "Зелена крапка = дитина в садочку. Позначайте лише тих, кого немає; повторний натиск знімає позначку."}</p>
  <div class="summary">
    <div class="sum ok"><b>${cnt.P}</b><span>присутні</span></div>
    <div class="sum no"><b>${abs}</b><span>відсутні</span></div>
    <div class="sum"><b>${pct}%</b><span>відвідування</span></div>
  </div>
  ${list.length === 0 ? `<div class="card">Список дітей порожній. Перейдіть на вкладку «Діти» і додайте дітей.</div>` : ""}
  ${groups.length > 1 ? `<div class="gtools">
      ${ro() ? "" : `<button class="linkbtn" onclick="go('settings')">Змінити порядок груп</button>`}
      <button class="linkbtn push" onclick="toggleAllGroups(${allOpen ? 0 : 1})">${
      allOpen ? "Згорнути всі групи" : "Розгорнути всі групи"}</button></div>` : ""}
  ${groups.map(g => groupCard(g, open.has(g.key), day)).join("")}
  <p class="legend"><i class="N">н</i>відсутній &nbsp; <i class="H">хв</i>хворіє &nbsp;
     <i class="K">кор</i>за кордоном &nbsp; <i class="V">виб</i>вибув — ставиться датою вибуття на вкладці «Діти»</p>`;
}
function groupCard(g, isOpen, day){
  const c = {P:0,N:0,H:0,K:0};
  g.kids.forEach(k => c[markOf(k, day)]++);
  const badges = ["N","H","K"].filter(k => c[k])
    .map(k => `<i class="${k}" title="${MARK_FULL[k]}: ${c[k]}">${MARK[k]} ${c[k]}</i>`).join("");
  return `<section class="gcard${isOpen ? " open" : ""}">
    <button class="ghead" aria-expanded="${isOpen}" onclick="toggleGroup(RV[${rv(g.key)}])">
      <span class="chev" aria-hidden="true"></span>
      <span class="gname">${esc(groupTitle(g.name))}</span>
      <span class="gbadges">${badges}</span>
      <span class="gcount"><b>${c.P}</b> з ${g.kids.length}</span>
    </button>
    ${isOpen ? `<div class="list">${g.kids.map((k,i) => kidRow(k, i+1, day)).join("")}</div>` : ""}
  </section>`;
}
function kidRow(c, n, day){
  const m = markOf(c, day);
  return `<div class="prow ${m==="P"?"":"m "+m}">
    <span class="num">${n}</span><span class="dot"></span>
    <span class="nm">${esc(c.full_name)}</span>
    <span class="marks">${["N","H","K"].map(k =>
      `<button class="mark" data-s="${k}" aria-pressed="${m===k}"
         aria-label="${esc(c.full_name)}: ${MARK_FULL[k]}"
         ${ro()?"disabled":`onclick="tapMark(${c.id},'${k}')"`}>${MARK[k]}</button>`).join("")}</span>
  </div>`;
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
  sameMonth ? rerender() : reload();
}
/* Стрілки перескакують вихідні та неробочі дні закладу */
function shiftDay(n){
  const d = new Date(S.curDate);
  for(let i = 0; i < 14; i++){
    d.setDate(d.getDate() + n);
    const s = iso(d);
    if(S.tab === "community" ? !isWeekend(s) : isWork(s)) break;
  }
  (S.tab === "community" ? setDateReload : setDate)(iso(d));
}

/* =====================================================================
   Вкладка «Місяць» — сітка з розділенням на групи
   ===================================================================== */
function viewMonth(){
  const days = workDays(S.vy, S.vm);
  const allGroups = groupsOf(yearKids());
  const groups = allGroups.filter(g => gfOk(g.key));
  const shown = groups.flatMap(g => g.kids);
  const multi = groups.length > 1;
  const cell = (c, d) => {
    const m = markOf(c, d);
    const clickable = !ro() && m !== "V" && m !== "X";
    return `<td class="cell ${clickable?"":"ro"} ${m==="P"||m==="X"?"":m}"
      ${clickable?`onclick="openPick(event,${c.id},'${d}')"`:""}>${m==="P"||m==="X"?"":MARK[m]}</td>`;
  };
  const presentRow = (kids, label, cls) => `<tr class="${cls}"><td class="num"></td><td class="name">${label}</td>${
    days.map(d => `<td>${kids.filter(c => markOf(c,d)==="P").length}</td>`).join("")}</tr>`;
  const body = groups.map(g => `
    <tr class="grp"><td class="num"></td>
      <td class="name"><b>${esc(groupTitle(g.name))}</b><span>${kidsWord(g.kids.length)}</span></td>
      ${days.length ? `<td colspan="${days.length}"></td>` : ""}</tr>
    ${g.kids.map((c,i) => `<tr><td class="num">${i+1}</td><td class="name" title="${esc(c.full_name)}">${esc(c.full_name)}</td>${
      days.map(d => cell(c,d)).join("")}</tr>`).join("")}
    ${multi ? presentRow(g.kids, "Присутніх у групі", "sub") : ""}`).join("");

  return `${instPicker()}
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)" aria-label="Попередній місяць">‹</button>
    <div class="monthname">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)" aria-label="Наступний місяць">›</button>
  </div>
  ${allGroups.length > 1 || S.groupFilter ? `<div class="toolbar">${groupSelect(allGroups)}${
      ro() || allGroups.length < 2 ? "" : `<button class="linkbtn" onclick="go('settings')">Змінити порядок груп</button>`}</div>` : ""}
  ${ro() ? `<span class="viewonly">Лише перегляд</span>` : ""}
  <p class="note">${ro()
    ? "Відділ освіти дані не змінює."
    : "Натисніть клітинку — і виберіть позначку зі списку. Вихідні та святкові дні у сітці не показуються."}</p>
  ${shown.length === 0 ? `<div class="card">${yearKids().length ? "У цій групі дітей немає." : "Список дітей порожній."}</div>` : `
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Прізвище, ім'я, по батькові</th>
      ${days.map(d => `<th>${new Date(d).getDate()}</th>`).join("")}</tr></thead>
    <tbody>${body}
      ${presentRow(shown, S.groupFilter ? "Присутніх у групі" : "Присутніх за день", "total")}
    </tbody></table></div>`}
  <p class="legend"><i class="N">н</i>відсутній &nbsp; <i class="H">хв</i>хворіє &nbsp;
     <i class="K">кор</i>за кордоном &nbsp; <i class="V">виб</i>вибув</p>`;
}
function shiftMonth(n){ const d = new Date(S.vy, S.vm + n, 1); S.vy = d.getFullYear(); S.vm = d.getMonth(); reload() }

function openPick(ev, id, day){
  const c = S.children.find(x => x.id === id);
  const m = markOf(c, day);
  const opts = [["P","Присутній"],["N","Відсутній"],["H","Хворіє"],["K","За кордоном"]];
  openLayer(`<div class="backdrop" onclick="closeLayer()"></div>
    <div class="popmenu" id="pm">
      <div class="ph">${esc(c.full_name)}<br>${new Date(day).toLocaleDateString("uk-UA",{day:"numeric",month:"long"})}</div>
      ${opts.map(([k,l]) => `<button onclick="pickMark(${id},'${day}','${k}')">
        <b class="${k}">${k==="P"?"✓":MARK[k]}</b>${l}${m===k?" ✓":""}</button>`).join("")}
    </div>`);
  const pm = el("pm"), r = ev.target.getBoundingClientRect(), h = pm.offsetHeight, w = pm.offsetWidth;
  pm.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  pm.style.top  = (r.bottom + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
}
function pickMark(id, day, k){ closeLayer(); setMark(id, day, k) }

/* =====================================================================
   Вкладка «Діти»
   ===================================================================== */
function kidsVisible(){
  const q = nkey(S.search);
  return sortedKids().filter(c => gfOk(nkey(c.group_name)) && (!q || nkey(c.full_name).includes(q)));
}
function viewKids(){
  const all = yearKids(), list = kidsVisible(), groups = groupsOf(all), names = groupNames();
  const today = todayISO(), sel = ro() ? null : S.sel, grouped = S.sortKey === "group";
  const active  = all.filter(c => (!c.left_on || c.left_on >= today) && (!c.enrolled_on || c.enrolled_on <= today)).length;
  const gone    = all.filter(c => c.left_on && c.left_on < today).length;
  const planned = all.filter(c => c.left_on && c.left_on >= today).length;
  const th = (k,l,cls="") => `<th class="${cls} sortable${S.sortKey===k?" sorted":""}" onclick="sortBy('${k}')">${l}${
    S.sortKey===k ? (S.sortDir>0?" ↑":" ↓") : ""}</th>`;
  /* клітинка: обрізаний текст + повне значення у підказці при наведенні */
  const td = (v, cls="") => `<td class="${cls}" title="${esc(v||"")}"><span class="cut">${esc(v||"")}</span></td>`;
  const box = (ids, label) => {
    const n = ids.filter(id => sel.has(id)).length;
    return `<input type="checkbox" aria-label="${label}" ${n && n === ids.length ? "checked" : ""} ${n && n < ids.length ? "data-mixed" : ""}
      onclick="event.stopPropagation();selIds(RV[${rv(ids)}], this.checked)">`;
  };

  let rows = "", n = 0, last = null;
  list.forEach(c => {
    const k = nkey(c.group_name);
    if(grouped && k !== last){
      last = k; n = 0;
      const ids = list.filter(x => nkey(x.group_name) === k).map(x => x.id);
      rows += `<tr class="grp"><td class="num"></td>
        ${ro() ? "" : `<td class="act">${sel ? box(ids, "Вибрати всю групу") : ""}</td>`}
        <td class="name"><b>${esc(groupTitle(k ? names.get(k) : ""))}</b><span>${kidsWord(ids.length)}</span></td>
        <td colspan="10"></td></tr>`;
    }
    n++;
    const cls = [S.flash.has(c.id) ? "fresh" : "", c.left_on && c.left_on < today ? "gone-row" : "",
                 sel && sel.has(c.id) ? "picked" : ""].join(" ").trim();
    rows += `<tr data-child="${c.id}" class="${cls}" ${sel ? `onclick="toggleSel(${c.id})"` : ""}>
      <td class="num">${n}</td>
      ${ro() ? "" : `<td class="act">${sel
        ? `<input type="checkbox" ${sel.has(c.id) ? "checked" : ""} aria-label="Вибрати: ${esc(c.full_name)}"
             onclick="event.stopPropagation();toggleSel(${c.id})">`
        : `<button class="mini" title="Редагувати" aria-label="Редагувати: ${esc(c.full_name)}" onclick="childDialog(${c.id})">✎</button>`}</td>`}
      ${td(c.full_name, "name")}
      ${td(c.group_name, "w-group")}
      <td>${c.birth_date ? fmtShort(c.birth_date) : ""}</td>
      ${td(c.parents, "w-par")}
      ${td(c.address, "w-adr")}
      ${td(c.phone, "w-tel")}
      ${td(c.edu_form, "w-form")}
      ${td(c.special_status, "w-st")}
      <td>${c.meal_benefit ? c.meal_benefit + "%" : ""}</td>
      <td>${c.enrolled_on ? fmtShort(c.enrolled_on) : ""}</td>
      <td>${c.left_on ? fmtShort(c.left_on) : ""}</td>
    </tr>`;
  });

  return `${instPicker()}
  <h2 class="title">Діти</h2>
  <p class="note">${active} у списку · ${gone} вибуло${planned ? ` · ${planned} з датою вибуття попереду` : ""}${ro() ? " · лише перегляд" : ""}.
     ${sel ? "Позначте дітей галочками — або цілу групу галочкою в її рядку. Дії з вибраними — внизу екрана."
           : ro() ? "" : "Щоб змінити дані, натисніть олівець на початку рядка."}
     Сортування — натисніть на заголовок стовпчика.</p>
  <div class="toolbar">
    <input id="kidSearch" placeholder="Пошук за прізвищем" aria-label="Пошук за прізвищем"
           value="${esc(S.search)}" oninput="S.search=this.value;rerender()">
    ${groupSelect(groups)}
    ${ro() ? "" : `<button class="btn btn-accent" onclick="childDialog(null)">+ Додати дитину</button>
    <button class="btn" onclick="importDialog()">Імпорт</button>
    <button class="btn" aria-pressed="${!!sel}" onclick="selMode(${sel ? "false" : "true"})">${sel ? "Закрити вибір" : "Вибрати кількох"}</button>`}
    <button class="btn" onclick="exportKids()">Excel</button>
  </div>
  ${list.length === 0 ? `<div class="card">${all.length
      ? "За цим пошуком нікого не знайдено."
      : "Список порожній. Додайте дітей по одній кнопкою «+ Додати дитину» або завантажте весь список кнопкою «Імпорт»."}</div>` : `
  <div class="scroll"><table class="grid">
    <thead><tr>
      <th class="num">№</th>
      ${ro() ? "" : `<th class="act">${sel ? box(list.map(c => c.id), "Вибрати всіх у списку") : ""}</th>`}
      ${th("name","Прізвище, ім'я, по батькові","name")}
      ${th("group","Група","w-group")}
      ${th("birth","Дата народж.")}
      <th class="w-par">Батьки (опікун)</th>
      <th class="w-adr">Домашня адреса</th>
      <th class="w-tel">Телефон</th>
      <th class="w-form">Форма здобуття</th>
      <th class="w-st">Спеціальний статус</th>
      <th>Пільга</th>
      <th>Зараховано</th>
      <th>Вибуття</th>
    </tr></thead>
    <tbody>${rows}
      ${ro() || sel ? "" : `<tr class="addrow"><td class="num"></td><td class="name" colspan="12">
        <button onclick="childDialog(null)">+ Додати дитину</button></td></tr>`}
    </tbody></table></div>`}
  <p class="legend">Наведіть курсор на клітинку — побачите повний текст.
     Дата вибуття закриває дитину: з наступного дня в сітці «виб», історія відвідування зберігається.</p>
  ${sel ? selBar(list) : ""}`;
}

/* ---------- Вибір кількох дітей: вибуття і переведення групою ---------- */
function selMode(on){ S.sel = on ? new Set() : null; rerender() }
function toggleSel(id){ if(!S.sel) return; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); rerender() }
function selIds(ids, on){ if(!S.sel) return; ids.forEach(id => on ? S.sel.add(id) : S.sel.delete(id)); rerender() }
function selectedKids(){ return S.children.filter(c => S.sel && S.sel.has(c.id)) }
function selBar(visible){
  const n = S.sel.size;
  return `<div class="selbar" role="region" aria-label="Дії з вибраними дітьми"><div class="selin">
    <div class="selinfo"><b>Вибрано: ${n}</b>
      ${visible.length ? `<button class="linkbtn" onclick="selIds(RV[${rv(visible.map(c => c.id))}], true)">Вибрати всіх</button>` : ""}
      ${n ? `<button class="linkbtn" onclick="selIds(RV[${rv([...S.sel])}], false)">Зняти</button>` : ""}
    </div>
    <button class="selx" aria-label="Закрити вибір" title="Закрити вибір" onclick="selMode(false)">✕</button>
    <div class="selact">
      <button class="btn btn-accent" ${n ? "" : "disabled"} onclick="bulkLeaveDialog()">Вибуття…</button>
      <button class="btn" ${n ? "" : "disabled"} onclick="bulkGroupDialog()">Перевести в групу…</button>
    </div>
  </div></div>`;
}
function groupSummary(kids){
  return groupsOf(kids).map(g => `${esc(groupTitle(g.name))}: ${g.kids.length}`).join(", ");
}
function bulkLeaveDialog(){
  RL = [];
  const kids = selectedKids(), y = curYear();
  const withDate = kids.filter(c => c.left_on).length;
  openLayer(`
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
    <h3>Вибуття: ${kidsWord(kids.length)}</h3>
    <p class="hint" style="margin-top:0">${groupSummary(kids)}</p>
    <div class="field"><label for="bl_date">Дата вибуття — останній день у закладі</label>
      <input id="bl_date" type="date" value="${y ? y.ends_on : todayISO()}"></div>
    <div class="chips">
      ${y ? `<button type="button" class="chip" onclick="setField('bl_date','${y.ends_on}')">Кінець року, ${fmtShort(y.ends_on)}</button>` : ""}
      <button type="button" class="chip" onclick="setField('bl_date','${todayISO()}')">Сьогодні</button>
    </div>
    <p class="hint">З наступного дня діти в сітці позначені «виб», історія відвідування зберігається.
      ${withDate ? `У ${withDate} з вибраних дата вибуття вже стоїть — її буде замінено.` : ""}</p>
    <button class="btn-main" onclick="bulkLeave(false)">Поставити вибуття</button>
    ${withDate ? `<button class="btn" style="width:100%;margin-top:7px" onclick="bulkLeave(true)">Зняти дату вибуття (${withDate})</button>` : ""}
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
  </div></div>`);
}
async function bulkLeave(clear){
  if(S.saving) return;
  const kids = selectedKids();
  const day = clear ? null : el("bl_date").value;
  if(!clear && !day) return toast("Оберіть дату вибуття", true);
  if(!clear){
    const early = kids.filter(c => c.enrolled_on && c.enrolled_on > day);
    if(early.length) return toast(`${early.slice(0,2).map(c => c.full_name).join(", ")}${early.length > 2 ? " та ще " + (early.length - 2) : ""}: зараховано пізніше за ${fmtShort(day)}`, true, 5000);
  }
  const ids = (clear ? kids.filter(c => c.left_on) : kids).map(c => c.id);
  if(!ids.length) return closeLayer();
  S.saving = true;
  try{
    const { data, error } = await sb.from("children").update({ left_on: day }).in("id", ids).select();
    if(error) throw error;
    mergeKids(data);
    S.flash = new Set(ids); S.sel = null;
    closeLayer(); rerender(); scrollToFlash();
    toast(clear ? `Дату вибуття знято: ${kidsWord((data || []).length)}`
                : `Вибуття поставлено: ${kidsWord((data || []).length)}`, false, 2600);
  }catch(e){ fail(e) }
  finally{ S.saving = false }
}
function bulkGroupDialog(){
  RL = [];
  const kids = selectedKids();
  const names = groupsOf(S.children).filter(g => g.key).map(g => g.name);
  openLayer(`
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
    <h3>Перевести в групу: ${kidsWord(kids.length)}</h3>
    <p class="hint" style="margin-top:0">Зараз: ${groupSummary(kids)}</p>
    <div class="field"><label for="bg_name">Нова група</label>
      <input id="bg_name" autocomplete="off" placeholder="напр. старша"></div>
    <div class="chips">${names.map(g => `<button type="button" class="chip" onclick="setField('bg_name', RL[${rl(g)}])">${esc(g)}</button>`).join("")}</div>
    <p class="hint">Так само можна виправити назву групи, вписану з помилкою: виберіть цілу групу
      і переведіть у правильну. Окремої історії груп система не веде, тому в минулих місяцях
      діти теж показуватимуться в новій групі — переводьте на початку навчального року.</p>
    <button class="btn-main" onclick="bulkGroup()">Перевести</button>
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
  </div></div>`);
  setTimeout(() => el("bg_name") && el("bg_name").focus(), 50);
}
async function bulkGroup(){
  if(S.saving) return;
  const name = canonGroup(el("bg_name").value);
  if(!name) return toast("Впишіть назву групи", true);
  const ids = selectedKids().map(c => c.id);
  const fromKeys = [...new Set(selectedKids().map(c => nkey(c.group_name)))];
  S.saving = true;
  try{
    const { data, error } = await sb.from("children").update({ group_name: name }).in("id", ids).select();
    if(error) throw error;
    mergeKids(data);
    await keepGroupPlace(fromKeys, nkey(name));
    S.flash = new Set(ids); S.sel = null;
    closeLayer(); rerender(); scrollToFlash();
    toast(`Переведено в «${name}»: ${kidsWord((data || []).length)}`, false, 2600);
  }catch(e){ fail(e) }
  finally{ S.saving = false }
}

/* Якщо всю групу перейменували («Перевести в групу»), нова назва
   займає місце старої у порядку груп. */
async function keepGroupPlace(fromKeys, newKey){
  if(fromKeys.length !== 1) return;
  const old = fromKeys[0];
  if(!old || old === newKey || !S.gorder.has(old)) return;
  if(yearKids().some(c => nkey(c.group_name) === old)) return;     // у старій групі ще хтось є
  try{
    if(S.gorder.has(newKey)){
      await sb.from("group_order").delete().eq("institution_id", S.instId).eq("group_key", old);
    }else{
      const { error } = await sb.from("group_order").update({ group_key: newKey })
        .eq("institution_id", S.instId).eq("group_key", old);
      if(error) throw error;
      S.gorder.set(newKey, S.gorder.get(old));
    }
    S.gorder.delete(old);
  }catch(e){ console.error("Порядок груп:", e) }
}

/* =====================================================================
   Звіт закладу
   ===================================================================== */
function monthStats(){
  const days = workDays(S.vy, S.vm).filter(d => d <= todayISO());
  const list = yearKids();
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
    all: list.length, out: list.filter(c => c.left_on && c.left_on < S.curDate).length, act: act.length,
    b50: act.filter(c => c.meal_benefit === "50").length,
    b100: act.filter(c => c.meal_benefit === "100").length, byF, byS };
}
function viewReport(){
  const r = monthStats();
  const other = Object.keys(r.byS).filter(s => !STATUSES_REF.includes(s));
  return `${instPicker()}
  <h2 class="title">Звіт</h2>
  <p class="note">${esc(instName(S.instId))} · ${monthName(S.vy,S.vm)} · ${esc(curYear()?.name||"")} н.р.</p>
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)" aria-label="Попередній місяць">‹</button>
    <div class="monthname">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)" aria-label="Наступний місяць">›</button>
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
    ${STATUSES_REF.concat(other).filter(s => r.byS[s]).map(s => `<div class="kv"><span>${esc(s)}</span><b>${r.byS[s]}</b></div>`).join("")
      || `<div class="kv"><span>Дітей зі статусом немає</span><b>0</b></div>`}</div>
  <div class="card"><h3>Пільги на харчування</h3>
    <div class="kv"><span>50%</span><b>${r.b50}</b></div>
    <div class="kv"><span>100%</span><b>${r.b100}</b></div></div>
  <button class="btn-main" onclick="exportReport()">Вивантажити сітку місяця в Excel</button>`;
}

/* =====================================================================
   Громада (відділ освіти)
   ===================================================================== */
function viewCommunity(){
  const rows = S.community || [];
  const work = rows.filter(r => r.is_work !== false);
  const total = work.reduce((s,r) => s + Number(r.kids), 0);
  const present = work.reduce((s,r) => s + Number(r.present), 0);
  const avg = total ? Math.round(present / total * 100) : 0;
  const weekend = isWeekend(S.curDate);
  return `
  <div class="datebar">
    <button class="btn" onclick="shiftDay(-1)" aria-label="Попередній день">‹</button>
    <input type="date" value="${S.curDate}" onchange="setDateReload(this.value)" aria-label="Дата">
    <button class="btn" onclick="shiftDay(1)" aria-label="Наступний день">›</button>
    <button class="btn" onclick="setDateReload('${todayISO()}')">Сьогодні</button>
  </div>
  <h2 class="title">${fmtLong(S.curDate)}</h2>
  <p class="note">${weekend
    ? "Вихідний день — відвідування не рахується."
    : "Загальна картина по громаді. Натисніть на заклад, щоб відкрити його сітку за місяць."}</p>
  <div class="summary">
    <div class="sum"><b>${total}</b><span>дітей у громаді</span></div>
    <div class="sum ok"><b>${present}</b><span>присутні</span></div>
    <div class="sum no"><b>${total - present}</b><span>відсутні</span></div>
    <div class="sum"><b>${avg}%</b><span>відвідування</span></div>
  </div>
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Заклад</th>
      <th>Дітей</th><th>Присутні</th><th>Відсутні</th><th>%</th></tr></thead>
    <tbody>${rows.map((r,i) => {
      const isW = r.is_work !== false;
      const pct = r.kids ? Math.round(r.present / r.kids * 100) : null;
      return `<tr class="clickable" onclick="openInst(${r.institution_id})">
        <td class="num">${i+1}</td><td class="name">${esc(r.name)}</td>
        <td>${r.kids}</td>
        ${isW ? `<td>${r.present}</td><td>${r.kids - r.present}</td>
          <td class="pct ${pct !== null && pct < 70 ? "low" : ""}">${pct === null ? "—" : pct + "%"}</td>`
          : `<td colspan="3" class="muted">неробочий день</td>`}
      </tr>`}).join("")}
      <tr class="total"><td class="num"></td><td class="name">Разом по громаді</td>
        <td>${total}</td><td>${present}</td><td>${total - present}</td><td>${avg}%</td></tr>
    </tbody></table></div>`;
}
function setDateReload(v){ if(!v) return; S.curDate = v; const d = new Date(v); S.vy = d.getFullYear(); S.vm = d.getMonth(); reload() }
function openInst(id){
  S.instId = id; S.groupFilter = ""; S.sel = null; S.tab = "month";
  renderTabs(); window.scrollTo(0,0); reload();
}

/* Відсоток кожного закладу рахує база — за його власними робочими днями
   і лише за ті дні, коли дитина була в списку. Середнє по громаді — зважене. */
function summaryCalc(){
  const rows = S.summary || [];
  const oldDays = workDays(S.vy, S.vm).filter(d => d <= todayISO()).length;   // запас для старої версії функції
  const abs = r => Number(r.n) + Number(r.h) + Number(r.k);
  const slots = r => r.slots != null ? Number(r.slots) : Number(r.kids) * oldDays;
  const pct = r => slots(r) ? Math.round((slots(r) - abs(r)) / slots(r) * 100) : null;
  const S1 = rows.reduce((s,r) => s + slots(r), 0), A1 = rows.reduce((s,r) => s + abs(r), 0);
  return { rows, abs, pct, avg: S1 ? Math.round((S1 - A1) / S1 * 100) : 0 };
}
function viewSummary(){
  const { rows, pct, avg } = summaryCalc();
  const sum = f => rows.reduce((s,r) => s + Number(r[f] || 0), 0);
  return `
  <div class="datebar">
    <button class="btn" onclick="shiftMonth(-1)" aria-label="Попередній місяць">‹</button>
    <div class="monthname">${monthName(S.vy,S.vm)}</div>
    <button class="btn" onclick="shiftMonth(1)" aria-label="Наступний місяць">›</button>
  </div>
  <h2 class="title">Звіт по громаді</h2>
  <p class="note">Відсоток кожного закладу рахується за його власними робочими днями, що вже минули.</p>
  <div class="summary">
    <div class="sum"><b>${sum("kids")}</b><span>дітей</span></div>
    <div class="sum ok"><b>${avg}%</b><span>середнє</span></div>
    <div class="sum no"><b>${sum("n")+sum("h")+sum("k")}</b><span>пропусків</span></div>
  </div>
  <div class="scroll"><table>
    <thead><tr><th class="num">№</th><th class="name">Заклад</th><th>Дітей</th><th>Роб. днів</th><th>%</th>
      <th>н</th><th>хв</th><th>кор</th><th>Пільга 50%</th><th>Пільга 100%</th><th>Вибули</th></tr></thead>
    <tbody>${rows.map((r,i) => { const p = pct(r); return `<tr>
      <td class="num">${i+1}</td><td class="name">${esc(r.name)}</td><td>${r.kids}</td>
      <td>${r.work_days ?? "—"}</td>
      <td class="pct ${p !== null && p < 70 ? "low" : ""}">${p === null ? "—" : p + "%"}</td>
      <td>${r.n}</td><td>${r.h}</td><td>${r.k}</td><td>${r.ben50}</td><td>${r.ben100}</td><td>${r.gone}</td>
    </tr>` }).join("")}
      <tr class="total"><td class="num"></td><td class="name">Разом</td><td>${sum("kids")}</td><td></td><td>${avg}%</td>
        <td>${sum("n")}</td><td>${sum("h")}</td><td>${sum("k")}</td>
        <td>${sum("ben50")}</td><td>${sum("ben100")}</td><td>${sum("gone")}</td></tr>
    </tbody></table></div>
  <button class="btn-main" style="margin-top:11px" onclick="exportSummary()">Вивантажити в Excel</button>`;
}

/* =====================================================================
   Налаштування: навчальні роки та неробочі дні
   ===================================================================== */
function viewSettings(){
  const y = curYear();
  const hol = [...S.holidays].filter(d => !y || (d >= y.starts_on && d <= yearEnd(y))).sort();
  return `${instPicker()}
  <h2 class="title">Налаштування</h2>
  <p class="note">${ro()
    ? "Кожен заклад веде це самостійно. Відділ освіти лише переглядає."
    : "Налаштування вашого закладу — на інші садочки вони не впливають."}</p>

  ${groupOrderCard()}

  <div class="card">
    <h3>Роки закладу</h3>
    ${S.years.length ? S.years.map(yy => `
      <div class="setrow">
        <div class="setinfo">
          <b>${esc(yy.name)}</b>${yy.is_current ? ` <span class="tagcur">поточний</span>` : ""}
          <small>${fmtShort(yy.starts_on)} — ${fmtShort(yy.ends_on)}</small>
        </div>
        ${ro() ? "" : `<button class="mini" title="Редагувати" onclick="yearDialog(${yy.id})">✎</button>`}
      </div>`).join("") : `<p class="hint">Жодного року ще не створено.</p>`}
    ${ro() ? "" : `<button class="btn btn-accent" style="width:100%;margin-top:10px"
      onclick="yearDialog(null)">+ Створити навчальний рік</button>`}
    <p class="hint" style="margin-bottom:0">Списки дітей переносяться самі: дитина без дати вибуття
      з'являється в новому році, а та, що вибула торік, у новий рік уже не потрапляє —
      але в старому році лишається разом з усією історією відвідування.
      Літо після кінця року (до 31 серпня) рахується до цього ж року.
      Перемикати роки можна тут або списком у шапці.</p>
  </div>

  <div class="card">
    <h3>Неробочі дні${y ? " — " + esc(y.name) : ""}</h3>
    <p class="hint" style="margin-top:0">Свята, канікули та інші дні, коли заклад не працює.
      Ці дні зникають із сітки місяця і не враховуються у відсотку. Суботи й неділі виключаються самі.</p>
    ${hol.length ? hol.map(d => `
      <div class="setrow">
        <div class="setinfo"><b>${fmtShort(d)}</b><small>${esc(S.holidayTitles[d] || "")}</small></div>
        ${ro() ? "" : `<button class="mini" aria-label="Видалити ${fmtShort(d)}" onclick="delHoliday('${d}')">✕</button>`}
      </div>`).join("") : `<p class="hint">Поки що не додано жодного дня.</p>`}
    ${ro() ? "" : `<div class="toolbar" style="margin:10px 0 0">
      <input id="hol_day" type="date" style="flex:0 0 150px" aria-label="Дата">
      <input id="hol_title" placeholder="Назва, напр. Різдво" aria-label="Назва">
      <button class="btn btn-accent" onclick="addHoliday()">Додати</button>
    </div>`}
  </div>`;
}

/* ---------- Порядок груп ---------- */
function groupOrderCard(){
  const groups = groupsOf(yearKids()).filter(g => g.key);
  const custom = groups.some(g => S.gorder.has(g.key));
  const canEdit = !ro() && S.gorderReady && groups.length > 1;
  const rows = groups.length < 2
    ? `<p class="hint">${groups.length ? "У закладі одна група — упорядковувати нічого."
                                      : "Груп ще немає: назви груп беруться з карток дітей."}</p>`
    : `<ol class="ordlist">${groups.map((g, i) => `
        <li class="ordrow">
          <span class="gpos" aria-hidden="true">${i + 1}</span>
          <span class="setinfo"><b>${esc(groupTitle(g.name))}</b><small>${kidsWord(g.kids.length)}</small></span>
          ${canEdit ? `
          <button class="ordbtn" id="gup_${i}" ${i === 0 ? "disabled" : ""}
            aria-label="Вище: ${esc(groupTitle(g.name))}" onclick="moveGroup(${i},-1)">↑</button>
          <button class="ordbtn" id="gdn_${i}" ${i === groups.length - 1 ? "disabled" : ""}
            aria-label="Нижче: ${esc(groupTitle(g.name))}" onclick="moveGroup(${i},1)">↓</button>` : ""}
        </li>`).join("")}</ol>`;
  const note = !S.gorderReady
      ? `Щоб задавати порядок, адміністратор системи має виконати в базі файл <b>sql/09-group-order.sql</b>.`
    : ro() ? "Порядок задає сам заклад."
    : groups.length < 2 ? ""
    : custom ? `Порядок задано вручну. Нова група стане в кінець списку, поки її не пересунете.
        <button class="linkbtn" onclick="resetGroupOrder()">Повернути автоматичний порядок</button>`
    : "Зараз діє автоматичний порядок: раннього віку, молодші, середні, старші, різновікові, решта. Пересуньте групу стрілками — і порядок стане вашим.";
  return `<div class="card">
    <h3>Порядок груп</h3>
    <p class="hint" style="margin-top:0">У такому порядку групи йдуть на «Сьогодні», у «Місяці»,
      на вкладці «Діти» і у вивантаженнях в Excel — на всіх телефонах і комп'ютерах закладу.</p>
    ${rows}
    ${note ? `<p class="hint" style="margin-bottom:0">${note}</p>` : ""}
  </div>`;
}

/* Стрілка переставляє групу одразу на екрані, а в базу порядок іде
   за пів секунди після останнього натиску — щоб швидкі натиски не сперечались. */
let gorderTimer = null;
function moveGroup(i, dir){
  const keys = groupsOf(yearKids()).filter(g => g.key).map(g => g.key);
  const j = i + dir;
  if(j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  keys.forEach((k, p) => S.gorder.set(k, p));
  S.focusAfter = [dir < 0 ? "gup_" : "gdn_", j];
  rerender();
  const inst = S.instId;
  clearTimeout(gorderTimer);
  gorderTimer = setTimeout(() => saveGroupOrder(inst, keys), 450);
}
async function saveGroupOrder(inst, keys){
  try{
    const { error } = await sb.from("group_order")
      .upsert(keys.map((k, p) => ({ institution_id: inst, group_key: k, pos: p })),
              { onConflict: "institution_id,group_key" });
    if(error) throw error;
    toast("Порядок груп збережено");
  }catch(e){
    fail(e);
    if(inst === S.instId){ await loadGroupOrder(); rerender() }
  }
}
async function resetGroupOrder(){
  clearTimeout(gorderTimer);
  try{
    const { error } = await sb.from("group_order").delete().eq("institution_id", S.instId);
    if(error) throw error;
    S.gorder = new Map();
    rerender(); toast("Повернуто автоматичний порядок");
  }catch(e){ fail(e) }
}

function yearDialog(id){
  RL = [];
  const y = id ? S.years.find(x => x.id === id) : null;
  const last = S.years[S.years.length - 1], now = new Date();
  /* новий рік пропонуємо одразу після останнього наявного */
  const n = last ? +last.starts_on.slice(0,4) + 1 : (now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1);
  const cur = y ? y.is_current : `${n}-09-01` <= todayISO();
  openLayer(`
  <div class="modal" onclick="if(event.target===this)closeLayer()"><div class="box">
    <h3>${y ? "Навчальний рік" : "Новий навчальний рік"}</h3>
    <p class="hint" style="margin-top:0">Заклад: <b>${esc(instName(S.instId))}</b></p>
    <div class="field"><label for="ny_name">Назва</label>
      <input id="ny_name" value="${esc(y ? y.name : n + "/" + (n+1))}"></div>
    <div class="field"><label for="ny_s">Початок</label>
      <input id="ny_s" type="date" value="${y ? y.starts_on : n + "-09-01"}"></div>
    <div class="field"><label for="ny_e">Кінець</label>
      <input id="ny_e" type="date" value="${y ? y.ends_on : (n+1) + "-05-31"}"></div>
    <label class="checkline"><input id="ny_cur" type="checkbox" ${cur ? "checked" : ""}>
      Зробити поточним</label>
    <p class="hint">Діти нікуди не копіюються: у рік потрапляють усі, хто перебував у закладі
      в межах цих дат. Вибулі раніше — не потрапляють. Літо після кінця року
      (до 31 серпня) теж належить цьому року, тож кінець можна лишати 31 травня.</p>
    <button class="btn-main" onclick="saveYear(${id || "null"})">Зберегти</button>
    <button class="btn" style="width:100%;margin-top:7px" onclick="closeLayer()">Скасувати</button>
    ${y && S.years.length > 1 ? `<button class="btn btn-danger" style="width:100%;margin-top:14px"
      onclick="deleteYear(${id})">Видалити рік</button>` : ""}
  </div></div>`);
  setTimeout(() => el("ny_name") && el("ny_name").focus(), 50);
}

async function saveYear(id){
  const name = el("ny_name").value.trim();
  const starts_on = el("ny_s").value, ends_on = el("ny_e").value;
  const is_current = el("ny_cur").checked;
  if(!name || !starts_on || !ends_on) return toast("Заповніть усі поля", true);
  if(starts_on >= ends_on) return toast("Кінець року має бути пізніше за початок", true);
  try{
    if(is_current) await sb.from("school_years").update({ is_current:false })
      .eq("institution_id", S.instId).neq("id", id || 0);
    let row;
    if(id){
      const { data, error } = await sb.from("school_years")
        .update({ name, starts_on, ends_on, is_current }).eq("id", id).select().single();
      if(error) throw error;
      row = data;
      S.years[S.years.findIndex(x => x.id === id)] = data;
    }else{
      const { data, error } = await sb.from("school_years")
        .insert({ institution_id: S.instId, name, starts_on, ends_on, is_current }).select().single();
      if(error) throw error;
      row = data; S.years.push(data);
    }
    if(is_current) S.years.forEach(x => x.is_current = x.id === row.id);
    S.years.sort((a,b) => a.starts_on.localeCompare(b.starts_on));
    S.yearId = row.id;
    const st = new Date(row.starts_on);
    S.vy = st.getFullYear(); S.vm = st.getMonth();
    if(S.curDate < row.starts_on || S.curDate > yearEnd(row)) S.curDate = row.starts_on;
    closeLayer(); renderYears(); reload(); toast("Збережено: " + name);
  }catch(e){ fail(e) }
}

async function deleteYear(id){
  const y = S.years.find(x => x.id === id);
  if(!confirm(`Видалити навчальний рік «${y.name}»?\nВідвідування і діти залишаться в базі — зникне лише сам проміжок.`)) return;
  try{
    const { error } = await sb.from("school_years").delete().eq("id", id);
    if(error) throw error;
    S.years = S.years.filter(x => x.id !== id);
    if(S.yearId === id) S.yearId = (S.years.find(x => x.is_current) || S.years[0])?.id;
    closeLayer(); renderYears(); reload(); toast("Видалено");
  }catch(e){ fail(e) }
}

async function addHoliday(){
  const day = el("hol_day").value, title = el("hol_title").value.trim();
  if(!day) return toast("Оберіть дату", true);
  try{
    const { error } = await sb.from("non_working_days")
      .upsert({ institution_id: S.instId, day, title }, { onConflict:"institution_id,day" });
    if(error) throw error;
    S.holidays.add(day); S.holidayTitles[day] = title;
    rerender(); toast("Додано " + fmtShort(day));
  }catch(e){ fail(e) }
}
async function delHoliday(day){
  try{
    const { error } = await sb.from("non_working_days").delete()
      .eq("institution_id", S.instId).eq("day", day);
    if(error) throw error;
    S.holidays.delete(day); delete S.holidayTitles[day];
    rerender(); toast("Видалено");
  }catch(e){ fail(e) }
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
/* Сітка місяця: групи окремими блоками, як на екрані */
function exportReport(){
  const days = workDays(S.vy, S.vm);
  const groups = groupsOf(yearKids());
  const presentRow = (kids, label) => ["", label, ...days.map(d => kids.filter(c => markOf(c,d)==="P").length), ""];
  const out = [["№","Прізвище, ім'я, по батькові", ...days.map(d => new Date(d).getDate()), "Присутніх днів"]];
  groups.forEach(g => {
    out.push(["", groupTitle(g.name)]);
    g.kids.forEach((c,i) => out.push([i+1, c.full_name,
      ...days.map(d => { const m = markOf(c,d); return m==="P"||m==="X" ? "" : MARK[m] }),
      days.filter(d => markOf(c,d)==="P").length]));
    if(groups.length > 1) out.push(presentRow(g.kids, "Присутніх у групі"));
  });
  out.push(presentRow(groups.flatMap(g => g.kids), "Присутніх за день"));
  download(`vidviduvannia-${instName(S.instId)}-${monthName(S.vy,S.vm)}.csv`, out);
}
function exportSummary(){
  const { rows, pct } = summaryCalc();
  const head = ["№","Заклад","Дітей","Робочих днів","% відвідування","н","хв","кор",
    "Пільга 50%","Пільга 100%","Вибули за місяць"];
  download(`zvit-gromady-${monthName(S.vy,S.vm)}.csv`,
    [head, ...rows.map((r,i) => [i+1, r.name, r.kids, r.work_days ?? "", pct(r) ?? "",
      r.n, r.h, r.k, r.ben50, r.ben100, r.gone])]);
}

/* =====================================================================
   Старт
   ===================================================================== */
(async () => {
  const { data:{ session } } = await sb.auth.getSession();
  if(session) await start(); else showLogin();
})();
