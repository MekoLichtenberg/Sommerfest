/* ════════════════════════════════════════════════════════════
   Sommerfest Scoreboard — Cloudflare Worker (sicheres Backend)

   Der GitHub-Token liegt NUR hier als geheime Variable.
   Die öffentlichen Seiten reden nur mit diesem Worker und
   sehen den Token nie.

   Benötigte Variablen (im Cloudflare-Dashboard setzen):
     Secrets:   GH_TOKEN, REGISTER_PW, REFEREE_PW, ADMIN_PW
     Variables: GH_USER, GH_REPO
   ════════════════════════════════════════════════════════════ */

const GH_API = 'https://api.github.com';
const FILE = 'scores.json';

/* ── Spiele ─────────────────────────────────────────────────────
   Anzeigenamen (NICHT geheim). Die Code→Spiel-Zuordnung kommt aus
   dem geheimen Secret GAME_CODES (JSON), damit die 4-stelligen
   Codes nicht im öffentlichen Repo stehen:
     GAME_CODES = {"1234":"dosenwerfen","5678":"sackwerfen", ...}    */
const GAME_LABELS = {
  dosenwerfen:    'Dosenwerfen',
  heisser_draht:  'Heißer Draht',
  sackwerfen:     'Sackwerfen',
  zeitnehmen:     'Zeitnehmen',
  kaesespiel:     'Käsespiel',
  fussballslalom: 'Fußballslalom',
  balancierfeder: 'Balancierfeder',
  bogenschiessen: 'Bogenschießen',
  spinnennetz:    'Spinnennetz',
  tetris:         'Tetris',
};

function gameFromCode(code, env) {
  let map = {};
  try { map = JSON.parse(env.GAME_CODES || '{}'); } catch (e) { map = {}; }
  const key = map[String(code || '').trim()];
  if (!key) return null;
  return { key, label: GAME_LABELS[key] || key };
}

/* Gesamtpunkte eines Teams = Summe aller Spiel-Werte */
function sumGames(team) {
  return Object.values(team.games || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/* ── UTF-8 sichere Base64 (wichtig für Emoji!) ── */
function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    'User-Agent': 'sommerfest-scoreboard',
    Accept: 'application/vnd.github+json',
  };
}

async function ghGetFile(env) {
  const url = `${GH_API}/repos/${env.GH_USER}/${env.GH_REPO}/contents/${FILE}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) {
    return { data: { title: 'Sommerfest', subtitle: '', teams: [] }, sha: null };
  }
  if (!res.ok) throw new Error('GitHub Lesefehler: ' + res.status);
  const body = await res.json();
  return { data: JSON.parse(decodeBase64(body.content)), sha: body.sha };
}

async function ghPutFile(env, data, sha) {
  data.updated = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const url = `${GH_API}/repos/${env.GH_USER}/${env.GH_REPO}/contents/${FILE}`;
  const body = {
    message: 'Update scores ' + data.updated,
    content: encodeBase64(JSON.stringify(data, null, 2)),
  };
  if (sha) body.sha = sha;
  return fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* Lesen → ändern → schreiben, mit Wiederholung bei Konflikt */
async function writeWithRetry(env, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, sha } = await ghGetFile(env);
    const newData = mutate(structuredClone(data));
    const res = await ghPutFile(env, newData, sha);
    if (res.ok) return newData;
    if (res.status === 409) continue; // sha veraltet → nochmal
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || ('Schreibfehler ' + res.status));
  }
  throw new Error('Gleichzeitige Änderung — bitte nochmal versuchen.');
}

function newId() {
  return 't_' + Math.random().toString(36).slice(2, 9);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const path = new URL(request.url).pathname;

    try {
      /* ── Öffentlich: aktuellen Stand lesen ── */
      if (path === '/api/scores' && request.method === 'GET') {
        const { data } = await ghGetFile(env);
        return json(data);
      }

      /* ── Login prüfen (nur Ja/Nein) ── */
      if (path === '/api/login' && request.method === 'POST') {
        const { role, password } = await request.json();
        const ok =
          (role === 'register' && password === env.REGISTER_PW) ||
          (role === 'referee'  && password === env.REFEREE_PW)  ||
          (role === 'admin'    && password === env.ADMIN_PW);
        return json({ ok: !!ok });
      }

      /* ── Spiel-Login: Code → Spiel + aktuelle Teams ── */
      if (path === '/api/game/login' && request.method === 'POST') {
        const { code } = await request.json();
        const game = gameFromCode(code, env);
        if (!game) return json({ ok: false });
        const { data } = await ghGetFile(env);
        return json({ ok: true, game: game.key, label: game.label, teams: data.teams || [] });
      }

      /* ── Spiel-Wertung setzen (0–5 für ein Team in diesem Spiel) ── */
      if (path === '/api/game/set' && request.method === 'POST') {
        const { code, teamId, value } = await request.json();
        const game = gameFromCode(code, env);
        if (!game) return json({ error: 'Ungültiger Code' }, 401);
        const v = Math.round(Number(value));
        if (!(v >= 0 && v <= 5)) return json({ error: 'Wert muss 0–5 sein' }, 400);
        const result = await writeWithRetry(env, d => {
          const team = (d.teams || []).find(t => t.id === teamId);
          if (!team) throw new Error('Team nicht gefunden');
          team.games = team.games || {};
          team.games[game.key] = v;
          const newPts = sumGames(team);
          if (newPts !== team.points) team.ts = Date.now();   // Zeitstempel für Tie-Break
          team.points = newPts;
          return d;
        });
        return json({ ok: true, game: game.key, teams: result.teams });
      }

      /* ── Team anmelden ── */
      if (path === '/api/register' && request.method === 'POST') {
        const { password, name, emoji } = await request.json();
        if (password !== env.REGISTER_PW) return json({ error: 'Falsches Passwort' }, 401);
        const clean = (name || '').trim();
        if (!clean) return json({ error: 'Bitte einen Teamnamen eingeben' }, 400);
        const result = await writeWithRetry(env, d => {
          d.teams = d.teams || [];
          if (d.teams.some(t => t.name.toLowerCase() === clean.toLowerCase())) {
            throw new Error('DUPLICATE');
          }
          d.teams.push({ id: newId(), name: clean, emoji: emoji || '⭐', points: 0, games: {} });
          return d;
        });
        return json({ ok: true, teams: result.teams });
      }

      /* ── Punkte vergeben (alt – wird nicht mehr genutzt, bleibt kompatibel) ── */
      if (path === '/api/points' && request.method === 'POST') {
        const { password, teamId, delta, set } = await request.json();
        if (password !== env.REFEREE_PW) return json({ error: 'Falsches Passwort' }, 401);
        const result = await writeWithRetry(env, d => {
          const team = (d.teams || []).find(t => t.id === teamId);
          if (!team) throw new Error('Team nicht gefunden');
          const before = team.points;
          if (typeof set === 'number')        team.points = Math.max(0, Math.round(set));
          else if (typeof delta === 'number') team.points = Math.max(0, (team.points || 0) + delta);
          if (team.points !== before) team.ts = Date.now();
          return d;
        });
        return json({ ok: true, teams: result.teams });
      }

      /* ── Organisator: volle Kontrolle (Titel, Teams löschen, alles setzen) ── */
      if (path === '/api/admin' && request.method === 'POST') {
        const { password, title, subtitle, teams } = await request.json();
        if (password !== env.ADMIN_PW) return json({ error: 'Falsches Passwort' }, 401);
        const result = await writeWithRetry(env, d => {
          if (typeof title === 'string')    d.title = title;
          if (typeof subtitle === 'string') d.subtitle = subtitle;
          if (Array.isArray(teams)) {
            const prev = new Map((d.teams || []).map(t => [t.id, t]));
            d.teams = teams.map(t => {
              const ex = prev.get(t.id);
              const pts = Math.max(0, Math.round(Number(t.points) || 0));
              return {
                id: t.id || newId(),
                name: (t.name || '').trim() || 'Team',
                emoji: t.emoji || '⭐',
                points: pts,
                games: ex ? (ex.games || {}) : {},                  // Spiel-Werte erhalten
                ts: (ex && ex.points === pts) ? ex.ts : Date.now(), // Zeitstempel erhalten / bei Änderung neu
              };
            });
          }
          return d;
        });
        return json({ ok: true, data: result });
      }

      return json({ error: 'Nicht gefunden' }, 404);

    } catch (e) {
      if (e.message === 'DUPLICATE') return json({ error: 'Diesen Teamnamen gibt es schon' }, 409);
      return json({ error: e.message || 'Serverfehler' }, 500);
    }
  },
};
