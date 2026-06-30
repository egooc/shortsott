import { useEffect, useMemo, useState } from 'react';
import ApiKeyInput from '../components/ApiKeyInput';
import { api } from '../lib/api';

const KEYS = [
  'YOUTUBE_API_KEY',
  'YOUTUBE_OAUTH_CLIENT_ID',
  'YOUTUBE_OAUTH_CLIENT_SECRET',
  'YOUTUBE_OAUTH_REDIRECT_URI',
  'YOUTUBE_OAUTH_REFRESH_TOKEN',
  'GEMINI_AUTH_MODE',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'VERTEX_GEMINI_MODEL'
];

const PLAIN_SETTING_KEYS = new Set([
  'YOUTUBE_OAUTH_CLIENT_ID',
  'YOUTUBE_OAUTH_REDIRECT_URI',
  'GEMINI_AUTH_MODE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'VERTEX_GEMINI_MODEL'
]);

const DEFAULTS = {
  YOUTUBE_OAUTH_REDIRECT_URI: 'http://localhost:3001/api/youtube-upload/oauth/callback',
  GEMINI_AUTH_MODE: 'vertex_adc',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  VERTEX_GEMINI_MODEL: 'gemini-2.5-flash'
};

function Field({ label, description, children }) {
  return (
    <label className="block text-xs font-bold text-slate-200">
      <span>{label}</span>
      {description ? <p className="mt-1 text-xs font-normal leading-5 text-slate-400">{description}</p> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function TextInput({ value, onChange, placeholder = '', type = 'text' }) {
  return (
    <input
      className="w-full rounded-2xl border border-white/10 bg-black/45 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-[#c8ff00]/70"
      value={value}
      type={type}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function InlineSaveField({ label, description, value, onChange, onSave, status, placeholder = '' }) {
  return (
    <Field label={label} description={description}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <TextInput value={value} onChange={onChange} placeholder={placeholder} />
        <button
          type="button"
          className="rounded-2xl bg-[#c8ff00] px-4 py-3 text-sm font-black text-black hover:brightness-110"
          onClick={onSave}
        >
          저장
        </button>
      </div>
      <StatusBox>{status}</StatusBox>
    </Field>
  );
}

function StatusBox({ children, tone = 'default' }) {
  if (!children) return null;
  const toneClass = tone === 'error'
    ? 'border-red-400/25 bg-red-500/10 text-red-100'
    : tone === 'success'
      ? 'border-[#c8ff00]/25 bg-[#c8ff00]/10 text-lime-100'
      : 'border-white/10 bg-black/30 text-slate-200';
  return <div className={`mt-3 rounded-2xl border px-4 py-3 text-sm leading-6 ${toneClass}`}>{children}</div>;
}

export default function Settings() {
  const [values, setValues] = useState({});
  const [statuses, setStatuses] = useState({});
  const [oauthMessage, setOauthMessage] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');

  useEffect(() => {
    api.get('/settings').then((res) => {
      const masked = res.data || {};
      const seeded = {};
      const seededStatuses = {};

      KEYS.forEach((key) => {
        seeded[key] = PLAIN_SETTING_KEYS.has(key) ? (masked[key] || DEFAULTS[key] || '') : '';
        seededStatuses[key] = masked[key] ? `저장됨: ${masked[key]}` : '';
      });

      Object.entries(DEFAULTS).forEach(([key, value]) => {
        if (!seeded[key]) seeded[key] = value;
      });

      setValues(seeded);
      setStatuses(seededStatuses);
    });
  }, []);

  const oauthReady = useMemo(() => {
    return Boolean(values.YOUTUBE_OAUTH_CLIENT_ID && values.YOUTUBE_OAUTH_CLIENT_SECRET && (values.YOUTUBE_OAUTH_REDIRECT_URI || DEFAULTS.YOUTUBE_OAUTH_REDIRECT_URI));
  }, [values.YOUTUBE_OAUTH_CLIENT_ID, values.YOUTUBE_OAUTH_CLIENT_SECRET, values.YOUTUBE_OAUTH_REDIRECT_URI]);

  function setValue(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function onSave(key) {
    try {
      const res = await api.post('/settings', { key, value: values[key] || '' });
      setStatuses((prev) => ({ ...prev, [key]: `저장 완료${res.data?.maskedValue ? `: ${res.data.maskedValue}` : ''}` }));
      return true;
    } catch (error) {
      setStatuses((prev) => ({ ...prev, [key]: `저장 실패: ${error.response?.data?.message || error.message}` }));
      return false;
    }
  }

  async function onTest(key) {
    try {
      const res = await api.post('/settings/test', { key });
      const info = res.data.channelTitle ? `${res.data.info}: ${res.data.channelTitle}` : (res.data.info || '연결 확인 완료');
      setStatuses((prev) => ({ ...prev, [key]: info }));
    } catch (error) {
      const detailSummary = error.response?.data?.details?.summary;
      const message = error.response?.data?.message || error.message;
      setStatuses((prev) => ({
        ...prev,
        [key]: `테스트 실패: ${message}${detailSummary ? ` | ${detailSummary}` : ''}`
      }));
    }
  }

  async function saveMany(keys) {
    for (const key of keys) {
      const ok = await onSave(key);
      if (!ok) return false;
    }
    return true;
  }

  async function openYouTubeOAuth() {
    setOauthMessage('');
    setOauthUrl('');

    if (!values.YOUTUBE_OAUTH_CLIENT_ID || !values.YOUTUBE_OAUTH_CLIENT_SECRET) {
      setOauthMessage('OAuth Client ID와 Client Secret을 먼저 입력한 뒤 연결하세요.');
      return;
    }

    try {
      const saved = await saveMany(['YOUTUBE_OAUTH_CLIENT_ID', 'YOUTUBE_OAUTH_CLIENT_SECRET', 'YOUTUBE_OAUTH_REDIRECT_URI']);
      if (!saved) {
        setOauthMessage('OAuth 설정 저장에 실패했습니다. 입력값을 확인하세요.');
        return;
      }
      const res = await api.get('/youtube-upload/oauth-url');
      setOauthUrl(res.data.authUrl);
      const popup = window.open(res.data.authUrl, '_blank', 'noopener,noreferrer');
      if (popup) {
        popup.focus();
        setOauthMessage('Google 권한 승인 창을 새 창으로 열었습니다. 승인 후 이 앱으로 돌아와 업로드 권한 테스트를 눌러주세요.');
      } else {
        setOauthMessage('브라우저가 새 창을 차단했습니다. 아래 OAuth 링크 열기 버튼을 눌러 새 탭에서 승인하세요.');
      }
    } catch (error) {
      setOauthMessage(`OAuth URL 생성 실패: ${error.response?.data?.message || error.message}`);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 text-slate-100">
      <section className="rounded-[28px] border border-white/10 bg-gradient-to-br from-[#101820] to-[#08110e] p-7 shadow-2xl">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-[#c8ff00]">Settings</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-white">3분 오뚝이영상 설정</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          소재 발굴, Gemini 분석, YouTube 업로드에 필요한 인증 정보를 관리합니다. YouTube 검색 API Key와 업로드 OAuth는 서로 다른 설정입니다.
        </p>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl">
          <div className="mb-4">
            <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">Source Discovery</p>
            <h2 className="mt-2 text-xl font-black text-white">YouTube 검색 API Key</h2>
            <p className="mt-1 text-sm text-slate-400">Phase 1에서 해시태그/조건 기반 쇼츠 후보를 찾을 때 사용합니다. 업로드에는 사용하지 않습니다.</p>
          </div>

          <ApiKeyInput
            label="YouTube Data API Key"
            description="검색 전용 API Key입니다. YouTube 업로드 OAuth와 별개입니다."
            value={values.YOUTUBE_API_KEY || ''}
            status={statuses.YOUTUBE_API_KEY}
            testLabel="테스트"
            saveLabel="저장"
            onChange={(next) => setValue('YOUTUBE_API_KEY', next)}
            onSave={() => onSave('YOUTUBE_API_KEY')}
            onTest={() => onTest('YOUTUBE_API_KEY')}
          />
        </div>

        <div className="rounded-[28px] border border-[#c8ff00]/20 bg-[#c8ff00]/10 p-5">
          <div className="mb-4">
            <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">Phase 3 Upload</p>
            <h2 className="mt-2 text-xl font-black text-white">YouTube 업로드 OAuth</h2>
            <p className="mt-1 text-sm leading-6 text-lime-100/80">
              자동 업로드와 예약 발행은 API Key가 아니라 OAuth 권한이 필요합니다. Google Cloud에서 OAuth Client를 만든 뒤 아래 값을 저장하세요.
            </p>
          </div>

          <div className="grid gap-3">

            <InlineSaveField
              label="OAuth Client ID"
              description="입력 후 저장하거나, 아래 YouTube OAuth 연결 버튼을 누르면 함께 저장됩니다."
              value={values.YOUTUBE_OAUTH_CLIENT_ID || ''}
              onChange={(next) => setValue('YOUTUBE_OAUTH_CLIENT_ID', next)}
              onSave={() => onSave('YOUTUBE_OAUTH_CLIENT_ID')}
              status={statuses.YOUTUBE_OAUTH_CLIENT_ID}
              placeholder="1234567890-xxxx.apps.googleusercontent.com"
            />

            <ApiKeyInput
              label="OAuth Client Secret"
              description="Google Cloud OAuth 클라이언트 시크릿입니다."
              value={values.YOUTUBE_OAUTH_CLIENT_SECRET || ''}
              status={statuses.YOUTUBE_OAUTH_CLIENT_SECRET}
              testLabel="안내"
              saveLabel="저장"
              onChange={(next) => setValue('YOUTUBE_OAUTH_CLIENT_SECRET', next)}
              onSave={() => onSave('YOUTUBE_OAUTH_CLIENT_SECRET')}
              onTest={() => setStatuses((prev) => ({
                ...prev,
                YOUTUBE_OAUTH_CLIENT_SECRET: 'Client Secret은 저장만 하면 됩니다. 실제 업로드 권한 테스트는 OAuth 연결 후 Refresh Token으로 확인합니다.'
              }))}
            />

            <InlineSaveField
              label="Redirect URI"
              description="Google Cloud OAuth Client의 Authorized redirect URIs에 이 값을 그대로 넣어야 합니다."
              value={values.YOUTUBE_OAUTH_REDIRECT_URI || DEFAULTS.YOUTUBE_OAUTH_REDIRECT_URI}
              onChange={(next) => setValue('YOUTUBE_OAUTH_REDIRECT_URI', next)}
              onSave={() => onSave('YOUTUBE_OAUTH_REDIRECT_URI')}
              status={statuses.YOUTUBE_OAUTH_REDIRECT_URI}
            />

            <ApiKeyInput
              label="Refresh Token"
              description="OAuth 승인 후 자동 저장됩니다. 직접 만들 필요는 없습니다."
              value={values.YOUTUBE_OAUTH_REFRESH_TOKEN || ''}
              status={statuses.YOUTUBE_OAUTH_REFRESH_TOKEN}
              testLabel="권한 테스트"
              saveLabel="저장"
              onChange={(next) => setValue('YOUTUBE_OAUTH_REFRESH_TOKEN', next)}
              onSave={() => onSave('YOUTUBE_OAUTH_REFRESH_TOKEN')}
              onTest={() => onTest('YOUTUBE_OAUTH_REFRESH_TOKEN')}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className={`rounded-2xl px-5 py-3 text-sm font-black shadow-[0_0_30px_rgba(200,255,0,0.18)] ${oauthReady ? 'bg-[#c8ff00] text-black hover:brightness-110' : 'border border-amber-300/30 bg-amber-400/10 text-amber-100'}`}
              onClick={openYouTubeOAuth}
            >
              YouTube OAuth 연결
            </button>
            <button
              type="button"
              className="rounded-2xl border border-[#c8ff00]/30 px-5 py-3 text-sm font-bold text-[#c8ff00] hover:bg-[#c8ff00]/10"
              onClick={() => onTest('YOUTUBE_OAUTH_REFRESH_TOKEN')}
            >
              업로드 권한 테스트
            </button>
            <button
              type="button"
              className="rounded-2xl border border-white/15 px-5 py-3 text-sm font-bold text-white hover:bg-white/10"
              onClick={openYouTubeOAuth}
            >
              다른 계정/채널로 재연결
            </button>
          </div>
          <StatusBox tone={oauthMessage.includes('실패') || oauthMessage.includes('먼저') ? 'error' : 'success'}>{oauthMessage}</StatusBox>
          {oauthUrl ? (
            <a
              href={oauthUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex rounded-2xl border border-[#c8ff00]/30 px-5 py-3 text-sm font-bold text-[#c8ff00] hover:bg-[#c8ff00]/10"
            >
              OAuth 링크 새 창에서 열기
            </a>
          ) : null}
          {!oauthReady ? (
            <StatusBox tone="error">
              OAuth Client ID와 Client Secret이 아직 없습니다. Google Cloud에서 OAuth Client를 만든 뒤 두 값을 먼저 입력하세요.
            </StatusBox>
          ) : null}
          <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-xs leading-5 text-amber-100">
            예약 발행은 YouTube 규칙에 따라 비공개로 업로드한 뒤 지정 시각에 공개됩니다.
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-[#c8ff00]">Metadata Analysis</p>
            <h2 className="mt-2 text-xl font-black text-white">Gemini / Vertex AI</h2>
            <p className="mt-1 text-sm text-slate-400">
              기본 권장 방식은 Vertex AI ADC입니다. Google Cloud 프로젝트와 리전을 저장한 뒤 연결 상태를 확인하세요.
            </p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-slate-200">
            권장: Vertex ADC
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="인증 방식">
            <select
              className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none focus:border-[#c8ff00]/60"
              value={values.GEMINI_AUTH_MODE || 'vertex_adc'}
              onChange={(event) => setValue('GEMINI_AUTH_MODE', event.target.value)}
            >
              <option value="vertex_adc">Vertex AI ADC</option>
              <option value="api_key">Gemini API Key</option>
            </select>
          </Field>

          <Field label="Google Cloud Project ID">
            <TextInput value={values.GOOGLE_CLOUD_PROJECT || ''} onChange={(next) => setValue('GOOGLE_CLOUD_PROJECT', next)} placeholder="my-gcp-project" />
          </Field>

          <Field label="Location">
            <TextInput value={values.GOOGLE_CLOUD_LOCATION || 'us-central1'} onChange={(next) => setValue('GOOGLE_CLOUD_LOCATION', next)} />
          </Field>

          <Field label="Vertex Gemini Model">
            <TextInput value={values.VERTEX_GEMINI_MODEL || 'gemini-2.5-flash'} onChange={(next) => setValue('VERTEX_GEMINI_MODEL', next)} />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-2xl bg-[#c8ff00] px-5 py-3 text-sm font-black text-black hover:brightness-110"
            onClick={() => saveMany(['GEMINI_AUTH_MODE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_GEMINI_MODEL'])}
          >
            Vertex 설정 저장
          </button>
          <button
            type="button"
            className="rounded-2xl border border-white/15 px-5 py-3 text-sm font-bold text-white hover:bg-white/10"
            onClick={() => onTest('GOOGLE_CLOUD_PROJECT')}
          >
            Vertex ADC 테스트
          </button>
        </div>
        <StatusBox>{statuses.GOOGLE_CLOUD_PROJECT}</StatusBox>

        <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4">
          <h3 className="text-sm font-black text-white">Fallback: Gemini API Key</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">Vertex ADC 대신 API Key 모드로 쓸 때만 입력하세요.</p>
          <div className="mt-3">
            <ApiKeyInput
              label="Gemini API Key"
              description="GEMINI_AUTH_MODE를 api_key로 사용할 때 필요합니다."
              value={values.GEMINI_API_KEY || ''}
              status={statuses.GEMINI_API_KEY}
              testLabel="테스트"
              saveLabel="저장"
              onChange={(next) => setValue('GEMINI_API_KEY', next)}
              onSave={() => onSave('GEMINI_API_KEY')}
              onTest={() => onTest('GEMINI_API_KEY')}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
