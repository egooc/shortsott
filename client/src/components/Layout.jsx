import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

const SIDEBAR_STORAGE_KEY = 'content_pipeline_sidebar_collapsed';

const T = {
  appName: '3\uBD84 \uC624\uB69D\uC774\uC601\uC0C1',
  studio: 'CAPCUT STUDIO',
  closeSidebar: '\uC0AC\uC774\uB4DC\uBC14 \uB2EB\uAE30',
  close: '\uB2EB\uAE30',
  openMenu: '\uBA54\uB274 \uC5F4\uAE30',
  closeMenu: '\uBA54\uB274 \uB2EB\uAE30',
  settings: '\uC124\uC815',
  scout: '1. \uC18C\uC7AC \uBC1C\uAD74',
  drafts: '2. \uBC30\uCE58 \uB4DC\uB798\uD504\uD2B8 \uC0DD\uC131',
  upload: '3. YouTube \uC5C5\uB85C\uB4DC',
  mainFlow: '\uC791\uC5C5 \uD750\uB984',
  helper: 'YouTube \uC18C\uC7AC\uB97C \uB2F4\uACE0, CapCut \uB4DC\uB798\uD504\uD2B8\uB97C \uB9CC\uB4ED\uB2C8\uB2E4.',
  capcutDefault: 'CapCut \uAE30\uBCF8 \uCD9C\uB825'
};

const phaseItems = [
  { label: T.settings, path: '/settings', group: 'settings', title: '\uD544\uC218 API\uC640 \uB85C\uCEEC \uC124\uC815' },
  { label: T.scout, path: '/phase-1', group: 'main', title: 'YouTube \uC18C\uC7AC \uAC80\uC0C9\uACFC \uD6C4\uBCF4 \uC120\uD0DD' },
  { label: T.drafts, path: '/phase-5', group: 'main', title: 'CapCut \uBC30\uCE58 \uB4DC\uB798\uD504\uD2B8 \uC0DD\uC131' },
  { label: T.upload, path: '/phase-3', group: 'main', title: 'YouTube \uBA54\uD0C0\uB370\uC774\uD130 \uC785\uB825\uACFC \uC608\uC57D \uC5C5\uB85C\uB4DC' }
];

function PhaseLink({ item, collapsed = false }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isActive = location.pathname === item.path;

  return (
    <button
      type="button"
      className={[
        'group relative w-full rounded-2xl px-4 py-3 text-left text-sm font-semibold transition',
        collapsed ? 'text-center' : '',
        isActive
          ? 'bg-[#c8ff00] text-black shadow-[0_0_32px_rgba(200,255,0,0.22)]'
          : 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
      ].join(' ')}
      onClick={() => navigate(item.path)}
      title={item.title || item.label}
      aria-label={item.label}
    >
      {collapsed ? item.label.split('. ')[0] || item.label[0] : item.label}
      {collapsed ? (
        <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-xl border border-white/10 bg-black/90 px-3 py-2 text-xs font-bold text-white shadow-xl group-hover:block">
          {item.label}
        </span>
      ) : null}
    </button>
  );
}

export default function Layout({ children }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (raw === '0') setSidebarCollapsed(false);
      if (raw === '1') setSidebarCollapsed(true);
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // ignore storage failures
    }
  }, [sidebarCollapsed]);

  return (
    <div className="min-h-screen overflow-hidden bg-[#07090d] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_52%_0%,rgba(200,255,0,0.14),transparent_30%),radial-gradient(circle_at_90%_10%,rgba(0,183,255,0.12),transparent_28%),linear-gradient(180deg,#07090d_0%,#0d1117_45%,#07090d_100%)]" />
      <div className="relative grid grid-cols-1 gap-5 p-3 md:p-5">
        <aside
          className={[
            'fixed inset-y-5 left-5 z-30 rounded-[28px] border border-white/10 bg-black/75 shadow-2xl shadow-black/50 backdrop-blur-xl transition-all',
            sidebarCollapsed ? 'w-[86px] p-3' : 'w-[280px] p-5'
          ].join(' ')}
        >
          <div className={['flex items-start gap-2', sidebarCollapsed ? 'justify-center' : 'justify-between'].join(' ')}>
            <Link to="/phase-1" className={['block font-black leading-tight tracking-tight text-white', sidebarCollapsed ? 'text-center text-sm' : 'text-xl'].join(' ')} title={T.appName}>
              {sidebarCollapsed ? '3\uBD84' : T.appName}
              {!sidebarCollapsed ? <span className="mt-2 block text-xs font-semibold uppercase tracking-[0.28em] text-[#c8ff00]">{T.studio}</span> : null}
            </Link>
            {!sidebarCollapsed ? (
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"
                onClick={() => setSidebarCollapsed(true)}
                title={T.closeSidebar}
              >
                {T.close}
              </button>
            ) : null}
          </div>

          <div className="mt-7 space-y-2">
            {phaseItems.filter((item) => item.group === 'settings').map((item) => <PhaseLink item={item} key={item.path} collapsed={sidebarCollapsed} />)}
          </div>

          <div className="mt-7 border-t border-white/10 pt-5">
            {!sidebarCollapsed ? <p className="mb-3 text-xs font-black uppercase tracking-[0.25em] text-[#c8ff00]">{T.mainFlow}</p> : null}
            <div className="space-y-2">
              {phaseItems.filter((item) => item.group === 'main').map((item) => <PhaseLink item={item} key={item.path} collapsed={sidebarCollapsed} />)}
            </div>
          </div>

          {!sidebarCollapsed ? (
            <div className="mt-5 rounded-3xl border border-[#c8ff00]/20 bg-[#c8ff00]/10 px-4 py-4 text-xs leading-5 text-lime-100" title={T.helper}>
              <div className="font-bold text-[#c8ff00]">{T.capcutDefault}</div>
              <div className="mt-1 text-lime-100/80">{T.helper}</div>
            </div>
          ) : null}
        </aside>

        <main className={['relative min-w-0 transition-all', sidebarCollapsed ? 'md:ml-[96px]' : 'md:ml-[300px]'].join(' ')}>
          <div className="mb-4 flex items-center justify-between">
            <button
              type="button"
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold text-slate-200 backdrop-blur hover:border-[#c8ff00]/40 hover:text-[#c8ff00]"
              onClick={() => setSidebarCollapsed((prev) => !prev)}
              title={sidebarCollapsed ? T.openMenu : T.closeMenu}
            >
              {sidebarCollapsed ? T.openMenu : T.closeMenu}
            </button>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
