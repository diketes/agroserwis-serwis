// Agroserwis Nysa — publiczna funkcja serwisowa (Supabase Edge Function)
// Trasy (pod /functions/v1/serwis):
//   GET  /sledz/:token        strona śledzenia naprawy dla klienta
//   GET  /api/sledz/:token    dane zlecenia (JSON)
//   GET  /reklamacja          formularz zgłoszenia naprawy (link ze strony WWW)
//   POST /api/reklamacja      przyjęcie zgłoszenia → tabela zlecenia (pobrane=false)
//   GET  /foto/:token         strona robienia zdjęć telefonem
//   POST /api/foto/:token     zapis zdjęcia do Storage + tabela zdjecia
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

// prosty limit zgłoszeń per IP (best-effort, pamięć instancji)
const ipMapa = new Map<string, number[]>();
function limitOk(ip: string): boolean {
  const teraz = Date.now();
  const lista = (ipMapa.get(ip) || []).filter((t) => teraz - t < 3600000);
  if (lista.length >= 5) return false;
  lista.push(teraz);
  ipMapa.set(ip, lista);
  return true;
}

function losowyToken(): string {
  const b = new Uint8Array(14);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // zetnij prefiks do /serwis (wewnątrz runtime'u ścieżka NIE zawiera /functions/v1)
  const sciezka = url.pathname.replace(/^.*?\/serwis/, "") || "/";
  // publicznie funkcja żyje pod /functions/v1/serwis — na sztywno, bo runtime
  // widzi inną ścieżkę niż przeglądarka
  const baza = "/functions/v1/serwis";
  const host = req.headers.get("x-forwarded-host") || url.host;
  const bazaAbs = `https://${host}${baza}`;

  // ── API: dane śledzenia ──
  const mSledzApi = sciezka.match(/^\/api\/sledz\/([a-f0-9]+)\/?$/);
  if (mSledzApi && req.method === "GET") {
    const { data: z } = await sb.from("zlecenia").select("*").eq("token", mSledzApi[1]).maybeSingle();
    if (!z) return json({ error: "Nie znaleziono" }, 404);
    const czesci = Array.isArray(z.czesci) ? z.czesci : [];
    const czTotal = czesci.reduce((s: number, c: { ilosc?: number; cena_jednostkowa?: number }) =>
      s + (Number(c.ilosc) || 0) * (Number(c.cena_jednostkowa) || 0), 0);
    return json({
      numer: z.numer, marka: z.marka, model: z.model, nr_seryjny: z.nr_seryjny,
      status: z.status, data_przyjecia: z.data_przyjecia,
      data_gotowosci: z.data_gotowosci, data_wydania: z.data_wydania,
      klient_imie: String(z.klient_nazwa || "").split(" ")[0] || "",
      koszt_calkowity: czTotal + (Number(z.koszt_robocizny) || 0),
    });
  }

  // ── strona śledzenia ──
  const mSledz = sciezka.match(/^\/sledz\/([a-f0-9]+)\/?$/);
  if (mSledz && req.method === "GET") return html(stronaSledz(baza, mSledz[1]));

  // ── formularz reklamacji ──
  if (/^\/reklamacja\/?$/.test(sciezka) && req.method === "GET") return html(stronaReklamacji(baza));

  if (sciezka === "/api/reklamacja" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.firma) return json({ ok: true, numer: "ZS-0000-00000" }); // honeypot
    const ip = req.headers.get("x-forwarded-for") || "?";
    if (!limitOk(ip)) return json({ ok: false, error: "Za dużo zgłoszeń — spróbuj za godzinę" }, 429);
    const nazwa = String(body.klient_nazwa || "").trim().slice(0, 120);
    const opis = String(body.opis_usterki || "").trim().slice(0, 2000);
    if (!nazwa || !opis) return json({ ok: false, error: "Podaj imię i nazwisko oraz opis usterki" }, 400);
    const token = losowyToken();
    const { error } = await sb.from("zlecenia").insert({
      token,
      numer: "WWW-" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + token.slice(0, 4).toUpperCase(),
      klient_nazwa: nazwa,
      klient_telefon: String(body.klient_telefon || "").trim().slice(0, 30),
      klient_email: String(body.klient_email || "").trim().slice(0, 120),
      marka: String(body.marka || "").trim().slice(0, 60),
      model: String(body.model || "").trim().slice(0, 60),
      nr_seryjny: String(body.nr_seryjny || "").trim().slice(0, 60),
      opis_usterki: opis,
      uwagi: "Reklamacja zgłoszona przez stronę agroserwisnysa.pl",
      status: "Przyjęto",
      data_przyjecia: new Date().toISOString(),
      zrodlo: "www",
      pobrane: false,
    });
    if (error) return json({ ok: false, error: "Błąd zapisu — spróbuj ponownie" }, 500);
    const { data: z } = await sb.from("zlecenia").select("numer").eq("token", token).single();
    return json({ ok: true, numer: z?.numer, tracking_url: `${bazaAbs}/sledz/${token}` }, 201);
  }

  // ── strona zdjęć telefonem ──
  const mFoto = sciezka.match(/^\/foto\/([a-f0-9]+)\/?$/);
  if (mFoto && req.method === "GET") {
    const { data: z } = await sb.from("zlecenia").select("numer,klient_nazwa,marka,model").eq("token", mFoto[1]).maybeSingle();
    if (!z) return html("Nie znaleziono zlecenia", 404);
    // minimalizacja danych — na stronie zdjęć tylko imię, nie pełne nazwisko
    z.klient_nazwa = String(z.klient_nazwa || "").split(" ")[0];
    return html(stronaFoto(baza, mFoto[1], z));
  }

  const mFotoApi = sciezka.match(/^\/api\/foto\/([a-f0-9]+)\/?$/);
  if (mFotoApi && req.method === "POST") {
    const token = mFotoApi[1];
    const { data: z } = await sb.from("zlecenia").select("token").eq("token", token).maybeSingle();
    if (!z) return json({ error: "Nie znaleziono zlecenia" }, 404);
    // limit liczby zdjęć na zlecenie — bez tego można zapchać Storage
    const { count } = await sb.from("zdjecia").select("id", { count: "exact", head: true }).eq("token", token);
    if ((count ?? 0) >= 30) return json({ error: "Osiągnięto limit zdjęć dla zlecenia" }, 429);
    const body = await req.json().catch(() => ({}));
    if (!body.typ || !body.data) return json({ error: "Brak danych" }, 400);
    const typ = body.typ === "po" ? "po" : "przed";
    const base64 = String(body.data).replace(/^data:image\/\w+;base64,/, "");
    // limit rozmiaru ~6 MB (base64 jest ~1.33× większy niż bajty)
    if (base64.length > 8_000_000) return json({ error: "Zdjęcie za duże (max ~6 MB)" }, 413);
    let bajty: Uint8Array;
    try { bajty = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); }
    catch { return json({ error: "Nieprawidłowe dane zdjęcia" }, 400); }
    // magic bytes JPEG (FF D8 FF) — nie pozwalamy hostować dowolnych plików
    if (bajty.length < 3 || bajty[0] !== 0xFF || bajty[1] !== 0xD8 || bajty[2] !== 0xFF) {
      return json({ error: "Plik nie jest zdjęciem JPEG" }, 400);
    }
    const path = `${token}/${typ}_${Date.now()}.jpg`;
    const { error: e1 } = await sb.storage.from("zdjecia").upload(path, bajty, { contentType: "image/jpeg" });
    if (e1) return json({ error: "Błąd zapisu zdjęcia" }, 500);
    const { error: e2 } = await sb.from("zdjecia").insert({ token, typ, path, pobrane: false });
    if (e2) return json({ error: "Błąd zapisu" }, 500);
    return json({ ok: true });
  }

  return html("Agroserwis Nysa — serwer działa ✓", sciezka === "/" ? 200 : 404);
});

// ───────────────────────── strony HTML ─────────────────────────

function stronaSledz(baza: string, token: string): string {
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Status naprawy — Agroserwis Nysa</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f1f5f9;min-height:100vh;padding:24px 14px}
.karta{max-width:480px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden}
.top{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:24px;text-align:center}
.top .logo{font-size:1.8rem}.top h1{font-size:1.05rem;font-weight:900;margin-top:4px}
.body{padding:22px}
.numer{font-family:monospace;font-size:1.35rem;font-weight:900;color:#16a34a;text-align:center;margin-bottom:14px}
.status{padding:14px;border-radius:12px;text-align:center;font-weight:900;font-size:1.05rem;margin-bottom:18px}
.wiersz{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:.9rem}
.wiersz span:first-child{color:#64748b}.wiersz span:last-child{font-weight:700;color:#1e293b}
.lad{text-align:center;color:#94a3b8;padding:40px 0}
</style></head><body>
<div class="karta">
  <div class="top"><div class="logo">⚙️</div><h1>Agroserwis Nysa — status naprawy</h1></div>
  <div class="body" id="tresc"><div class="lad">Ładowanie...</div></div>
</div>
<script>
const KOLORY = {'Przyjęto':['#dbeafe','#1d4ed8'],'W naprawie':['#fef3c7','#854d0e'],'Czeka na części':['#ffedd5','#9a3412'],'Gotowe':['#dcfce7','#15803d'],'Wydano':['#e2e8f0','#475569']};
const d = s => s ? new Date(s).toLocaleDateString('pl-PL') : '—';
// escapowanie — dane zlecenia mogą pochodzić z publicznego formularza reklamacji
const e = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
fetch('${baza}/api/sledz/${token}').then(r => { if(!r.ok) throw 0; return r.json(); }).then(z => {
  const k = KOLORY[z.status] || KOLORY['Przyjęto'];
  document.getElementById('tresc').innerHTML =
    '<div class="numer">' + e(z.numer) + '</div>' +
    '<div class="status" style="background:' + k[0] + ';color:' + k[1] + '">' + e(z.status) + '</div>' +
    (z.klient_imie ? '<div class="wiersz"><span>Klient</span><span>' + e(z.klient_imie) + '</span></div>' : '') +
    '<div class="wiersz"><span>Sprzęt</span><span>' + (e([z.marka, z.model].filter(Boolean).join(' ')) || '—') + '</span></div>' +
    (z.nr_seryjny ? '<div class="wiersz"><span>Nr seryjny</span><span>' + e(z.nr_seryjny) + '</span></div>' : '') +
    '<div class="wiersz"><span>Przyjęto</span><span>' + d(z.data_przyjecia) + '</span></div>' +
    '<div class="wiersz"><span>Gotowe</span><span>' + d(z.data_gotowosci) + '</span></div>' +
    '<div class="wiersz"><span>Wydano</span><span>' + d(z.data_wydania) + '</span></div>' +
    (z.koszt_calkowity ? '<div class="wiersz"><span>Koszt</span><span>' + Number(z.koszt_calkowity).toFixed(2) + ' zł</span></div>' : '');
}).catch(() => {
  document.getElementById('tresc').innerHTML = '<div class="lad">Nie znaleziono zlecenia</div>';
});
</script></body></html>`;
}

function stronaReklamacji(baza: string): string {
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reklamacja / naprawa — Agroserwis Nysa</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f1f5f9;min-height:100vh;padding:24px 14px}
.karta{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden}
.naglowek{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:26px 24px;text-align:center}
.naglowek .logo{font-size:2rem;margin-bottom:6px}.naglowek h1{font-size:1.2rem;font-weight:900}
.naglowek p{font-size:.82rem;color:rgba(255,255,255,.75);margin-top:4px}
form{padding:22px}
label{display:block;font-size:.78rem;font-weight:700;color:#475569;margin:12px 0 4px}
label .req{color:#dc2626}
input,textarea{width:100%;padding:11px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:.95rem;font-family:inherit}
input:focus,textarea:focus{outline:none;border-color:#16a34a}
.rzad{display:flex;gap:10px}.rzad>div{flex:1}
button{width:100%;margin-top:18px;padding:15px;border:none;border-radius:12px;background:#16a34a;color:#fff;font-size:1.05rem;font-weight:900;cursor:pointer}
button:disabled{opacity:.6}
.stopka{text-align:center;font-size:.75rem;color:#94a3b8;padding:0 22px 22px}
#wynik{display:none;padding:34px 24px;text-align:center}
#wynik .ikona{font-size:3rem;margin-bottom:10px}#wynik h2{font-size:1.15rem;color:#15803d;margin-bottom:8px}
#wynik p{font-size:.9rem;color:#475569;line-height:1.6}
#wynik .numer{font-family:monospace;font-size:1.2rem;font-weight:900;color:#16a34a;display:block;margin:10px 0}
#wynik a{display:inline-block;margin-top:14px;background:#16a34a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:100px;font-weight:800}
#blad{display:none;margin-top:12px;background:#fef2f2;border:1px solid #fecaca;color:#dc2626;border-radius:10px;padding:10px;font-size:.85rem;text-align:center}
.hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
</style></head><body>
<div class="karta">
  <div class="naglowek"><div class="logo">⚙️</div><h1>Agroserwis Nysa — zgłoszenie naprawy</h1>
  <p>Wypełnij formularz — przyjmiemy Twój sprzęt do serwisu i dostaniesz link do śledzenia naprawy</p></div>
  <form id="formularz">
    <label>Imię i nazwisko <span class="req">*</span></label>
    <input name="klient_nazwa" required maxlength="120" placeholder="Jan Kowalski">
    <div class="rzad">
      <div><label>Telefon</label><input name="klient_telefon" type="tel" maxlength="30" placeholder="500 000 000"></div>
      <div><label>E-mail</label><input name="klient_email" type="email" maxlength="120" placeholder="jan@email.com"></div>
    </div>
    <div class="rzad">
      <div><label>Marka sprzętu</label><input name="marka" maxlength="60" placeholder="np. VENOM"></div>
      <div><label>Model</label><input name="model" maxlength="60" placeholder="np. GS-460"></div>
    </div>
    <label>Nr seryjny (jeśli znasz)</label>
    <input name="nr_seryjny" maxlength="60" placeholder="z tabliczki znamionowej">
    <label>Opis usterki <span class="req">*</span></label>
    <textarea name="opis_usterki" required rows="4" maxlength="2000" placeholder="Opisz, co się dzieje ze sprzętem..."></textarea>
    <div class="hp"><label>Firma</label><input name="firma" tabindex="-1" autocomplete="off"></div>
    <button type="submit" id="wyslij">Wyślij zgłoszenie</button>
    <div id="blad"></div>
  </form>
  <div class="stopka">Agroserwis Nysa · ul. Dmowskiego 2, 48-303 Nysa · tel. 880 109 005</div>
  <div id="wynik">
    <div class="ikona">✅</div><h2>Zgłoszenie przyjęte!</h2>
    <p>Twój numer zgłoszenia:<span class="numer" id="wynikNumer"></span>
    Skontaktujemy się w sprawie dostarczenia sprzętu.<br>Postęp naprawy możesz śledzić na bieżąco:</p>
    <a id="wynikLink" href="#">🔍 Śledź naprawę</a>
  </div>
</div>
<script>
document.getElementById('formularz').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, btn = document.getElementById('wyslij'), blad = document.getElementById('blad');
  blad.style.display = 'none'; btn.disabled = true; btn.textContent = 'Wysyłanie...';
  const dane = {}; new FormData(f).forEach((v, k) => { dane[k] = v; });
  try {
    const r = await fetch('${baza}/api/reklamacja', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dane) });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Błąd wysyłania');
    f.style.display = 'none';
    document.getElementById('wynikNumer').textContent = j.numer;
    const a = document.getElementById('wynikLink');
    if (j.tracking_url) a.href = j.tracking_url; else a.style.display = 'none';
    document.getElementById('wynik').style.display = 'block';
  } catch (e) {
    blad.textContent = e.message || 'Nie udało się wysłać — spróbuj ponownie';
    blad.style.display = 'block'; btn.disabled = false; btn.textContent = 'Wyślij zgłoszenie';
  }
});
</script></body></html>`;
}

function stronaFoto(baza: string, token: string, z: { numer?: string; klient_nazwa?: string; marka?: string; model?: string }): string {
  const sprzet = [z.marka, z.model].filter(Boolean).join(" ");
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Zdjęcia — ${esc(z.numer)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px 16px 40px}
.head{text-align:center;margin-bottom:20px}
.brand{color:#4ade80;font-weight:900;font-size:1.05rem}
.numer{font-family:monospace;font-size:1.4rem;font-weight:900;margin-top:4px}
.info{color:#94a3b8;font-size:.85rem;margin-top:2px}
.typy{display:flex;gap:8px;margin-bottom:16px}
.typ{flex:1;padding:13px;border-radius:12px;border:2px solid #334155;background:none;color:#94a3b8;font-size:.95rem;font-weight:800;cursor:pointer}
.typ.active{border-color:#16a34a;background:#14532d;color:#dcfce7}
.foto-btn{width:100%;padding:20px;border:none;border-radius:16px;background:#16a34a;color:#fff;font-size:1.25rem;font-weight:900;cursor:pointer;margin-bottom:14px}
#status{text-align:center;font-size:.9rem;min-height:24px;margin-bottom:12px;color:#4ade80;font-weight:700}
#lista{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
#lista img{width:100px;height:100px;object-fit:cover;border-radius:10px;border:2px solid #16a34a}
</style></head><body>
<div class="head">
  <div class="brand">⚙️ Agroserwis Nysa</div>
  <div class="numer">${esc(z.numer)}</div>
  <div class="info">${esc(z.klient_nazwa)}${sprzet ? " · " + esc(sprzet) : ""}</div>
</div>
<div class="typy">
  <button class="typ active" id="tPrzed" onclick="ustawTyp('przed')">🔧 Przed naprawą</button>
  <button class="typ" id="tPo" onclick="ustawTyp('po')">✅ Po naprawie</button>
</div>
<button class="foto-btn" onclick="document.getElementById('plik').click()">📷 Zrób zdjęcie</button>
<input type="file" id="plik" accept="image/*" capture="environment" style="display:none">
<div id="status">Wybierz typ i zrób zdjęcie — wyśle się samo</div>
<div id="lista"></div>
<script>
let typ = 'przed';
function ustawTyp(t) {
  typ = t;
  document.getElementById('tPrzed').classList.toggle('active', t === 'przed');
  document.getElementById('tPo').classList.toggle('active', t === 'po');
}
document.getElementById('plik').addEventListener('change', async (ev) => {
  const plik = ev.target.files[0]; ev.target.value = '';
  if (!plik) return;
  const st = document.getElementById('status');
  st.textContent = 'Wysyłanie...';
  try {
    const bmp = await createImageBitmap(plik);
    const skala = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * skala); c.height = Math.round(bmp.height * skala);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.82);
    const r = await fetch('${baza}/api/foto/${token}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typ, data }) });
    if (!r.ok) throw new Error(r.status);
    st.textContent = '✓ Wysłano! Możesz zrobić kolejne';
    const img = document.createElement('img'); img.src = data;
    document.getElementById('lista').prepend(img);
  } catch {
    st.textContent = '✗ Nie udało się wysłać — spróbuj jeszcze raz';
    st.style.color = '#f87171';
    setTimeout(() => { st.style.color = '#4ade80'; }, 2500);
  }
});
</script></body></html>`;
}
