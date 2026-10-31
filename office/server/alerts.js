// 기기 경고 판단(순수 로직, 시험 tests/office_alerts_test.js). 보내기는 notify 로 넘긴다.
//   · 재부팅: 연결기가 싣는 boot_at 이 바뀌면 바로(3분 만에 다시 붙으면 «10분 끊김»이 안 울린다, 10-31 17:40).
//   · Orca 꺼짐: orca_ok=false 가 2분 넘게 이어지면 한 번.
//   · 세션 사라짐: 30분 넘게 보이던 세션이 5분째 안 보이면 묶어서 한 번. Orca 가 꺼져 있거나 기기가 끊긴 동안, 돌아온 뒤 5분은 재지 않는다.
const BOOT_DIFF_MS = 120e3;
const ORCA_DOWN_MS = 120e3;
const STABLE_MS = 30 * 60e3;
const GONE_MS = 5 * 60e3;
const FORGET_MS = 24 * 3600e3;

const clean = (t) => String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);
const hasOrca = (device, state) => device !== 'vps' && !!state && state.orca_ok !== undefined;

function makeAlerts({ notify, now = Date.now }) {
  const orca = new Map(); // device → { at, told }
  const seen = new Map(); // device → Map(title → { first, last })
  const quiet = new Map(); // device → 이 시각까지 세션 사라짐을 재지 않는다

  function onState(device, prev, state) {
    const a = Date.parse(prev?.boot_at || ''), b = Date.parse(state?.boot_at || '');
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) > BOOT_DIFF_MS) {
      notify({ title: '기기 재부팅됨', body: `${device} 가 ${kst(b)}에 다시 켜졌습니다. Orca와 세션을 확인하세요.`, tag: `boot-${device}`, url: '/' });
    }
    const t = now();
    const map = seen.get(device) || new Map();
    seen.set(device, map);
    for (const s of state?.sessions || []) {
      if (s.agent !== 'claude' || s.cc_status === undefined) continue;
      const title = clean(s.title);
      if (!title) continue;
      const e = map.get(title) || { first: t, last: t };
      e.last = t;
      map.set(title, e);
    }
  }

  // 오피스 «닫기»로 닫은 세션은 알리지 않는다
  function forget(device, title) { seen.get(device)?.delete(clean(title)); }

  function tick(devices) {
    const t = now();
    for (const [device, d] of devices) {
      const online = !!(d.ws && d.ws.readyState === 1);
      const state = d.state;
      const down = online && hasOrca(device, state) && state.orca_ok === false;
      if (down) {
        const o = orca.get(device) || { at: t, told: false };
        orca.set(device, o);
        if (!o.told && t - o.at >= ORCA_DOWN_MS) {
          o.told = true;
          notify({ title: 'Orca 꺼짐', body: `${device} 의 Orca가 응답하지 않습니다. 오피스에서 «Orca 켜기»를 눌러 주세요.`, tag: `orca-${device}`, url: '/' });
        }
      } else orca.delete(device);
      if (!online || down) { quiet.set(device, t + GONE_MS); continue; }
      const map = seen.get(device);
      if (!map || t < (quiet.get(device) || 0)) continue;
      const gone = [];
      for (const [title, e] of map) {
        if (t - e.last >= FORGET_MS) { map.delete(title); continue; }
        if (e.last - e.first >= STABLE_MS && t - e.last >= GONE_MS) { gone.push(title); map.delete(title); }
      }
      if (gone.length) {
        notify({ title: `세션 ${gone.length}개 사라짐`, body: `${device}: ${gone.slice(0, 6).join(', ')}${gone.length > 6 ? ` 외 ${gone.length - 6}개` : ''}`, tag: `gone-${device}`, url: '/' });
      }
    }
  }
  return { onState, tick, forget };
}

module.exports = { makeAlerts, hasOrca };
