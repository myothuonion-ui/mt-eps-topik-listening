import { useEffect, useState } from 'react';
import type { BoundaryAutomation, BrowserName, DiagnosticError, ListeningJob, ListeningQuestion, PipelineStageKey, StageState, ToolStatus, VoiceProfile, YoutubeAccess } from '../shared';

type SystemVoice = { name: string; culture: string; gender: string };
type Status = { version: string; tools: ToolStatus; voices: SystemVoice[]; geminiTts: { models: string[]; voices: string[] } };
type SourceMode = 'youtube' | 'upload' | 'text';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let data: any = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function media(url: string | null, version?: string) { return url ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version ?? '1')}` : ''; }
const defaultProfile: VoiceProfile = {
  provider: 'gemini', narratorVoice: '', maleVoice: '', femaleVoice: '', rate: 0, pitch: 0, volume: 100, pauseMs: 450,
  geminiApiKey: '', geminiModel: 'gemini-3.1-flash-tts-preview', geminiNarratorVoice: 'Kore', geminiMaleVoice: 'Charon', geminiFemaleVoice: 'Aoede',
  geminiStyle: 'Natural Korean EPS-TOPIK listening-test delivery. Clear pronunciation, neutral emotion, no extra words.'
};
const defaultAutomation: BoundaryAutomation = {
  mode: 'full-auto', geminiApiKey: '', geminiModel: 'gemini-2.5-flash', nvidiaApiKey: '', nvidiaModel: 'meta/llama-3.1-8b-instruct',
  cloudflareApiToken: '', cloudflareAccountId: '', cloudflareModel: '@cf/meta/llama-3.1-8b-instruct'
};

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<SourceMode>('youtube');
  const [url, setUrl] = useState('');
  const [youtubeAccess, setYoutubeAccess] = useState<YoutubeAccess>({ mode: 'auto', browser: 'chrome' });
  const [accessResult, setAccessResult] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [numberedText, setNumberedText] = useState('');
  const [job, setJob] = useState<ListeningJob | null>(null);
  const [profile, setProfile] = useState<VoiceProfile>(defaultProfile);
  const [automation, setAutomation] = useState<BoundaryAutomation>(defaultAutomation);
  const [rememberGeminiKey, setRememberGeminiKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [topError, setTopError] = useState('');
  const [customText, setCustomText] = useState('');
  const [customJob, setCustomJob] = useState<ListeningJob | null>(null);
  const [testJob, setTestJob] = useState<ListeningJob | null>(null);

  useEffect(() => {
    void refreshStatus();
    const savedKey = window.localStorage.getItem('mt-eps-listening-gemini-key') ?? '';
    const savedProvider = window.localStorage.getItem('mt-eps-listening-tts-provider');
    if (savedKey) { setProfile(previous => ({ ...previous, geminiApiKey: savedKey })); setRememberGeminiKey(true); }
    if (savedProvider === 'windows' || savedProvider === 'gemini') setProfile(previous => ({ ...previous, provider: savedProvider }));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('mt-eps-listening-tts-provider', profile.provider);
    if (rememberGeminiKey && profile.geminiApiKey.trim()) window.localStorage.setItem('mt-eps-listening-gemini-key', profile.geminiApiKey.trim());
    else window.localStorage.removeItem('mt-eps-listening-gemini-key');
  }, [profile.provider, profile.geminiApiKey, rememberGeminiKey]);

  useEffect(() => {
    if (!status?.voices.length) return;
    const korean = status.voices.filter(voice => /^ko/i.test(voice.culture));
    if (!korean.length) return;
    const first = korean[0]?.name ?? '';
    const male = (korean.find(voice => /male/i.test(voice.gender)) ?? korean[0])?.name ?? first;
    const female = (korean.find(voice => /female/i.test(voice.gender)) ?? korean[0])?.name ?? first;
    setProfile(previous => previous.narratorVoice ? previous : { ...previous, narratorVoice: female, maleVoice: male, femaleVoice: female });
  }, [status?.voices.length]);

  async function refreshStatus() {
    try { setStatus(await api<Status & { ok: true }>('/api/status')); } catch (error) { setTopError(error instanceof Error ? error.message : 'Status failed.'); }
  }

  useEffect(() => pollWhileActive(job, setJob), [job?.id, job?.status]);
  useEffect(() => pollWhileActive(customJob, setCustomJob), [customJob?.id, customJob?.status]);
  useEffect(() => pollWhileActive(testJob, setTestJob), [testJob?.id, testJob?.status]);

  function pollWhileActive(value: ListeningJob | null, setter: (job: ListeningJob) => void) {
    if (!value || !['queued', 'running'].includes(value.status)) return undefined;
    const timer = window.setInterval(() => void pollJob(value.id, setter), 700);
    return () => window.clearInterval(timer);
  }

  async function pollJob(id: string, setter: (job: ListeningJob) => void) {
    try { const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${id}`); setter(response.job); } catch {}
  }

  async function start() {
    setTopError(''); setBusy('Starting…'); setJob(null);
    try {
      const boundaryAutomation = { ...automation, geminiApiKey: profile.geminiApiKey };
      if (mode === 'youtube') {
        const response = await api<{ ok: true; job: ListeningJob }>('/api/jobs/youtube', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, access: youtubeAccess, automation: boundaryAutomation }) });
        setJob(response.job);
      } else if (mode === 'upload') {
        if (!file) throw new Error('Choose an audio/video file first.');
        const body = new FormData(); body.append('file', file); body.append('automation', JSON.stringify(boundaryAutomation));
        const response = await api<{ ok: true; job: ListeningJob }>('/api/jobs/upload', { method: 'POST', body }); setJob(response.job);
      } else {
        const response = await api<{ ok: true; job: ListeningJob }>('/api/jobs/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: numberedText }) }); setJob(response.job);
      }
    } catch (error) { setTopError(error instanceof Error ? error.message : 'Could not start.'); }
    finally { setBusy(''); }
  }

  async function testAccess() {
    setTopError(''); setAccessResult(''); setBusy('Testing YouTube access…');
    try {
      const result = await api<{ ok: true; title: string; mode: string }>('/api/youtube/test-access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, access: youtubeAccess }) });
      setAccessResult(`Access ready: ${result.title}`);
    } catch (error) { setTopError(error instanceof Error ? error.message : 'YouTube access test failed.'); }
    finally { setBusy(''); }
  }

  async function updateDownloader() {
    setTopError(''); setBusy('Updating yt-dlp safely…');
    try { await api('/api/tools/yt-dlp/update', { method: 'POST' }); await refreshStatus(); }
    catch (error) { setTopError(error instanceof Error ? error.message : 'yt-dlp update failed.'); }
    finally { setBusy(''); }
  }

  async function generateAll() {
    if (!job) return; setTopError(''); setBusy('Voice generation started…');
    try { const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/tts-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); setJob(response.job); }
    catch (error) { setTopError(error instanceof Error ? error.message : 'Voice generation failed.'); }
    finally { setBusy(''); }
  }

  async function testVoice() {
    setTopError(''); setBusy(`Testing ${profile.provider === 'gemini' ? 'Gemini' : 'Windows'} voice…`);
    try { const response = await api<{ ok: true; job: ListeningJob }>('/api/tts/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); setTestJob(response.job); }
    catch (error) { setTopError(error instanceof Error ? error.message : 'Voice test failed.'); }
    finally { setBusy(''); }
  }

  async function exportFinal() {
    if (!job) return; setBusy('Building final package…'); setTopError('');
    try { const response = await api<{ ok: true; job: ListeningJob; downloadUrl: string }>(`/api/jobs/${job.id}/export`, { method: 'POST' }); setJob(response.job); window.location.href = response.downloadUrl; }
    catch (error) { setTopError(error instanceof Error ? error.message : 'Export failed.'); }
    finally { setBusy(''); }
  }

  async function approveMapAndCut() {
    if (!job) return; setBusy('Cutting approved boundary map…'); setTopError('');
    try { const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/approve-map-and-cut`, { method: 'POST' }); setJob(response.job); }
    catch (error) { setTopError(error instanceof Error ? error.message : 'Approved map cut failed.'); }
    finally { setBusy(''); }
  }

  async function customVoice() {
    if (!customText.trim()) return; setBusy(customJob ? 'Regenerating custom voice…' : 'Generating custom voice…'); setTopError('');
    try { const response = await api<{ ok: true; job: ListeningJob }>('/api/custom-voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: customText, profile }) }); setCustomJob(response.job); }
    catch (error) { setTopError(error instanceof Error ? error.message : 'Custom voice failed.'); }
    finally { setBusy(''); }
  }

  return <div className="shell">
    <header className="topbar">
      <div><span className="brand">MT</span><div><h1>EPS TOPIK Listening Factory</h1><p>YouTube / audio → boundary agents → source questions mapped to Q1–Q20 → voice → final package</p></div></div>
      <div className="tool-row"><Tool name="FFmpeg" ok={status?.tools.ffmpeg}/><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="Whisper" ok={status?.tools.whisper}/><Tool name="PO Token" ok={status?.tools.poTokenProvider.status === 'ready'}/><span className="version">v{status?.version ?? '1.2.0'}</span></div>
    </header>

    {topError && <div className="toast-error">{topError}</div>}
    {busy && <div className="busy"><span className="spinner" />{busy}</div>}

    <main>
      <section className="card source-card">
        <div className="card-head"><div><small>01 SOURCE</small><h2>Start Listening Job</h2></div><span className="pill">Local media production</span></div>
        <div className="tabs">{(['youtube','upload','text'] as SourceMode[]).map(source => <button key={source} className={mode === source ? 'active' : ''} onClick={() => setMode(source)}>{source === 'youtube' ? 'YouTube URL' : source === 'upload' ? 'Audio / Video File' : 'Q1–Q20 Text'}</button>)}</div>
        {mode === 'youtube' && <>
          <input className="big-input" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
          <div className="youtube-access"><h3>YouTube Access</h3><div className="radio-row">
            <label><input type="radio" checked={youtubeAccess.mode === 'auto'} onChange={() => setYoutubeAccess({ ...youtubeAccess, mode: 'auto' })} /> Auto / Public</label>
            <label><input type="radio" checked={youtubeAccess.mode === 'browser'} onChange={() => setYoutubeAccess({ ...youtubeAccess, mode: 'browser' })} /> Use browser session</label>
          </div>{youtubeAccess.mode === 'browser' && <label>Browser<select value={youtubeAccess.browser} onChange={event => setYoutubeAccess({ mode: 'browser', browser: event.target.value as BrowserName })}><option value="chrome">Chrome</option><option value="edge">Edge</option><option value="firefox">Firefox</option></select></label>}
          <button className="secondary" onClick={testAccess} disabled={!url.trim() || !!busy}>Test Access</button>{accessResult && <span className="access-ok">✓ {accessResult}</span>}
          <p className="muted">Browser cookies are used only when you explicitly select this option. Cookie values are never stored, exported, or logged.</p></div>
        </>}
        {mode === 'upload' && <label className="file-drop"><input type="file" accept="audio/*,video/*" onChange={event => setFile(event.target.files?.[0] ?? null)} /><strong>{file?.name ?? 'Choose MP3 / WAV / MP4 / M4A / WebM'}</strong><span>Original upload is preserved; FFmpeg creates a separate normalized source.wav</span></label>}
        {mode === 'text' && <textarea className="source-text" value={numberedText} onChange={event => setNumberedText(event.target.value)} placeholder={'Q1: 남자: ...\n여자: ...\n\nQ2: ...\n\n... Q20:'} />}
        {mode !== 'text' && <BoundaryAutomationPanel automation={automation} setAutomation={setAutomation} geminiApiKey={profile.geminiApiKey} setGeminiApiKey={key => setProfile({ ...profile, geminiApiKey: key })} />}
        <button className="primary large" onClick={start} disabled={!!busy || (mode === 'youtube' && !url.trim()) || (mode === 'upload' && !file) || (mode === 'text' && !numberedText.trim())}>ANALYZE LISTENING</button>
      </section>

      <ToolManager status={status} updateDownloader={updateDownloader} />

      {job && <>
        <Progress job={job} />
        {job.error && <ErrorPanel error={job.error} />}
        {!!job.warnings.length && <section className="card warning-card"><h3>Review warnings</h3>{job.warnings.map(warning => <p key={warning}>⚠ {warning}</p>)}</section>}
        {!!job.transcript.length && <TranscriptPanel job={job} />}
        {!!job.questions.length && <section className="card">
          <div className="card-head"><div><small>03 BOUNDARY MAP</small><h2>Question Audio Boundaries</h2></div><span className="pill">{job.sourceQuestionRange ? `Source Q${job.sourceQuestionRange.start}–Q${job.sourceQuestionRange.end}` : 'Q1–Q20'} → Output Q1–Q20</span></div>
          <div className="boundary-summary"><span>Mode<b>{modeLabel(job.processingMode)}</b></span><span>Boundary Agent<b>{job.boundaryAgent}</b></span><span>Auto-cut<b>{job.autoCutCount}/20</b></span><span>Needs review<b>{job.reviewCount}/20</b></span></div>
          <p className="muted">Section ranges and explicit question numbers are trusted first. Audio silence and agent verification repair missing boundaries; spoken answer choices 1–4 are ignored as question markers.</p>
          <div className="question-list">{job.questions.map(question => <QuestionCard key={question.number} job={job} q={question} profile={profile} onJob={setJob} />)}</div>
          {(job.processingMode === 'manual' || job.reviewCount > 0) && <div className="approve-bar"><div><strong>{job.processingMode === 'manual' ? 'Manual map is waiting for your approval.' : `${job.reviewCount} uncertain boundaries are waiting for review.`}</strong><p>After checking or editing timestamps, cut the complete current map.</p></div><button className="primary large" onClick={approveMapAndCut} disabled={!!busy}>Approve Map & Cut Audio</button></div>}
        </section>}
        {!!job.questions.length && <VoiceStudio status={status} profile={profile} setProfile={setProfile} rememberGeminiKey={rememberGeminiKey} setRememberGeminiKey={setRememberGeminiKey} onGenerateAll={generateAll} onTest={testVoice} testJob={testJob} />}
        {!!job.questions.length && <section className="card export-card">
          <div><small>05 FINAL</small><h2>Export Listening Package</h2><p>Uses Gemini/Windows TTS when available and falls back question-by-question to cut source audio.</p></div>
          <button className="primary large" onClick={exportFinal} disabled={!!busy}>DOWNLOAD FINAL ZIP</button>
          {job.exportUrl && <a className="download-link" href={job.exportUrl}>Download again</a>}
        </section>}
        <Logs job={job} />
      </>}

      <section className="card custom-card">
        <div className="card-head"><div><small>EXTRA</small><h2>Custom Korean Text → Voice</h2></div><span className="pill">{profile.provider === 'gemini' ? 'Gemini TTS' : 'Windows Local TTS'}</span></div>
        <textarea value={customText} onChange={event => setCustomText(event.target.value)} placeholder={'남자: 오늘 몇 시에 출근합니까?\n여자: 아침 여덟 시에 출근합니다.'} />
        <button className="secondary" onClick={customVoice} disabled={!customText.trim() || !!busy || (profile.provider === 'gemini' && !profile.geminiApiKey.trim())}>{customJob ? 'Regenerate' : 'Generate Custom Voice'}</button>
        {customJob?.questions[0]?.ttsAudioUrl && <div className="audio-result"><audio controls src={media(customJob.questions[0].ttsAudioUrl, customJob.updatedAt)} /><a href={customJob.questions[0].ttsAudioUrl} download="custom-korean-voice.mp3">Download MP3</a></div>}
        {customJob?.error && <ErrorPanel error={customJob.error} />}
      </section>
    </main>
  </div>;
}

function modeLabel(mode: BoundaryAutomation['mode']) {
  return mode === 'full-auto' ? 'Full Auto Agent' : mode === 'safe-auto' ? 'Safe Auto' : 'Manual';
}

function BoundaryAutomationPanel({ automation, setAutomation, geminiApiKey, setGeminiApiKey }: {
  automation: BoundaryAutomation;
  setAutomation: (value: BoundaryAutomation) => void;
  geminiApiKey: string;
  setGeminiApiKey: (value: string) => void;
}) {
  const modes: { value: BoundaryAutomation['mode']; title: string; description: string }[] = [
    { value: 'full-auto', title: 'Full Auto Agent Mode', description: 'Agent validates the complete map and cuts all 20 immediately. No user approval.' },
    { value: 'safe-auto', title: 'Safe Auto Mode', description: 'Cuts high-confidence questions immediately and shows only uncertain boundaries.' },
    { value: 'manual', title: 'Manual Mode', description: 'Builds the complete boundary map but waits for Approve Map & Cut Audio.' }
  ];
  return <div className="automation-panel">
    <div className="automation-title"><div><small>BOUNDARY CONTROL</small><h3>Agent Processing Mode</h3></div><span className="pill">{modeLabel(automation.mode)}</span></div>
    <div className="mode-cards">{modes.map(item => <label key={item.value} className={automation.mode === item.value ? 'selected' : ''}><input type="radio" checked={automation.mode === item.value} onChange={() => setAutomation({ ...automation, mode: item.value })} /><span><b>{item.title}</b><small>{item.description}</small></span></label>)}</div>
    {automation.mode !== 'manual' && <details className="agent-settings" open>
      <summary>Agent API fallback settings <span>Gemini → NVIDIA → Cloudflare</span></summary>
      <div className="agent-key-grid">
        <label>Gemini API Key<input type="password" autoComplete="off" value={geminiApiKey} onChange={event => setGeminiApiKey(event.target.value)} placeholder="Google AI Studio key" /></label>
        <label>Gemini boundary model<input value={automation.geminiModel} onChange={event => setAutomation({ ...automation, geminiModel: event.target.value })} /></label>
        <label>NVIDIA API Key<input type="password" autoComplete="off" value={automation.nvidiaApiKey} onChange={event => setAutomation({ ...automation, nvidiaApiKey: event.target.value })} placeholder="NVIDIA API key" /></label>
        <label>NVIDIA model<input value={automation.nvidiaModel} onChange={event => setAutomation({ ...automation, nvidiaModel: event.target.value })} /></label>
        <label>Cloudflare Account ID<input autoComplete="off" value={automation.cloudflareAccountId} onChange={event => setAutomation({ ...automation, cloudflareAccountId: event.target.value })} /></label>
        <label>Cloudflare API Token<input type="password" autoComplete="off" value={automation.cloudflareApiToken} onChange={event => setAutomation({ ...automation, cloudflareApiToken: event.target.value })} /></label>
        <label className="wide">Cloudflare model<input value={automation.cloudflareModel} onChange={event => setAutomation({ ...automation, cloudflareModel: event.target.value })} /></label>
      </div>
      <p className="muted">The first valid agent response wins; failures automatically fall through to the next configured provider. NVIDIA and Cloudflare credentials are session-only; Gemini follows the explicit Voice Studio “Remember” setting. No key is written to job.json, logs, exports, or Git. Timestamped transcript evidence is sent only to the provider being tried.</p>
    </details>}
  </div>;
}

function Tool({ name, ok }: { name: string; ok: boolean | undefined }) { return <span className={`tool ${ok ? 'ok' : 'off'}`}><i />{name}</span>; }

function ToolManager({ status, updateDownloader }: { status: Status | null; updateDownloader: () => void }) {
  const info = status?.tools.ytdlpInfo;
  const provider = status?.tools.poTokenProvider;
  return <section className="card tool-manager"><div className="card-head"><div><small>LOCAL TOOLS</small><h2>Downloader & Transcript Tools</h2></div><button className="secondary" onClick={updateDownloader} disabled={!status || (info?.activeJobs ?? 0) > 0}>Update yt-dlp</button></div>
    <div className="tool-grid"><label>yt-dlp installed<b>{info?.installedVersion ?? 'Not installed'}</b></label><label>Latest version<b>{info?.latestVersion ?? 'Could not check'}</b></label><label>Status<b>{info?.status === 'update-available' ? 'Update available' : info?.status === 'current' ? 'Current' : info?.status ?? 'Checking'}</b></label><label>PO Token Provider<b className={provider?.status === 'ready' ? 'good' : 'warn'}>{provider?.status === 'ready' ? 'Ready' : 'Missing'}</b></label><label>Whisper<b>{status?.tools.whisper ? 'Installed' : 'Not installed'}</b></label></div>
    <p className="muted">{provider?.detail}</p>{!status?.tools.whisper && <p className="muted">Whisper is only required when Korean captions are unavailable. Setup: <code>powershell -File scripts\Setup-Tools.ps1</code></p>}
  </section>;
}

const STAGES: { key: PipelineStageKey; label: string }[] = [
  { key: 'validate', label: 'Validate' }, { key: 'download', label: 'Download' }, { key: 'normalize', label: 'Normalize' }, { key: 'transcript', label: 'Transcript' },
  { key: 'split', label: 'Split Q1–Q20' }, { key: 'clip', label: 'Cut Audio' }, { key: 'voice', label: 'Voice' }, { key: 'export', label: 'Export' }
];
const stateIcon: Record<StageState, string> = { waiting: '○', running: '▶', success: '✓', failed: '✕', skipped: '–' };

function Progress({ job }: { job: ListeningJob }) {
  const blocks = Array.from({ length: 14 }, (_, index) => (index + 1) / 14 * 100 <= job.percent);
  const currentLabel = STAGES.find(stage => stage.key === (job.stage === 'transcribe' ? 'transcript' : job.stage === 'tts' ? 'voice' : job.stage))?.label ?? job.stage;
  return <section className="card progress-card">
    <div className="progress-title"><div><small>02 PROGRESS</small><h2>{job.currentAgent}</h2><p>{job.logs.at(-1)?.message ?? job.stage}</p></div><strong>{job.percent}%</strong></div>
    <div className="block-progress fourteen">{blocks.map((on, index) => <span key={index} className={on ? 'on' : ''} />)}</div>
    <div className="stage-row">{STAGES.map(stage => { const state = job.stageStates?.[stage.key] ?? 'waiting'; return <span key={stage.key} className={state}>{stateIcon[state]} {stage.label}</span>; })}</div>
    <div className="progress-facts"><span>Current Question: <b>{job.currentQuestion ? `Q${String(job.currentQuestion).padStart(2, '0')}` : '—'}</b></span><span>Current Stage: <b>{currentLabel}</b></span><span>Current Agent: <b>{job.currentAgent}</b></span><span>Last Success: <b>{job.lastSuccessfulStage ? STAGES.find(stage => stage.key === job.lastSuccessfulStage)?.label : '—'}</b></span></div>
    <div className="question-grid">{Array.from({ length: 20 }, (_, index) => index + 1).map(number => { const state = job.questionStates?.[String(number)] ?? 'waiting'; return <span key={number} className={state}>Q{String(number).padStart(2, '0')} {stateIcon[state]}</span>; })}</div>
  </section>;
}

function ErrorPanel({ error }: { error: DiagnosticError }) {
  const fields = [
    ['Stage', error.stage], ['Question', error.question ? `Q${String(error.question).padStart(2, '0')}` : '—'], ['Agent', error.agent], ['Provider', error.provider ?? '—'],
    ['Tool', error.tool ?? '—'], ['HTTP', error.httpStatus ?? '—'], ['Exit code', error.exitCode ?? '—'], ['Retryable', error.retryable === undefined ? '—' : error.retryable ? 'YES' : 'NO']
  ];
  return <section className="card error-panel"><div className="error-title"><span>ERROR ID</span><strong>{error.code}</strong></div><p>{new Date(error.timestamp).toLocaleString()}</p><div className="error-grid">{fields.map(([label, value]) => <label key={String(label)}>{label}<b>{String(value)}</b></label>)}</div><h3>{error.reason}</h3>{error.source && <p>Source: {error.source}</p>}<div className="fix"><strong>FIX</strong>{error.fix}</div>{error.detail && <details><summary>Technical details</summary><pre>{error.detail}</pre></details>}</section>;
}

function TranscriptPanel({ job }: { job: ListeningJob }) {
  return <section className="card"><div className="card-head"><div><small>TRANSCRIPT</small><h2>{job.transcriptSource === 'caption' ? 'YouTube timestamped Korean captions' : job.transcriptSource === 'whisper' ? 'Whisper timestamp transcript' : 'Text source'}</h2></div><span className="pill">{job.transcript.length} segments</span></div><div className="transcript-box">{job.transcript.map((segment, index) => <p key={`${segment.start}-${index}`}><time>{formatTime(segment.start)} → {formatTime(segment.end)}</time><span>{segment.text}</span></p>)}</div></section>;
}

function QuestionCard({ job, q, profile, onJob }: { job: ListeningJob; q: ListeningQuestion; profile: VoiceProfile; onJob: (job: ListeningJob) => void }) {
  const [draft, setDraft] = useState(q);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setDraft(q), [q.start, q.end, q.transcript, q.script, q.ttsAudioUrl, q.sourceAudioUrl, q.type, q.correctAnswerIndex]);
  const choices = Array.from({ length: 4 }, (_, index) => draft.choices[index] ?? '');
  async function save() {
    setSaving('Saving…'); setError('');
    try {
      const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: Number(draft.start), end: Number(draft.end), type: draft.type, transcript: draft.transcript, script: draft.script, questionText: draft.questionText, choices, correctAnswerIndex: draft.correctAnswerIndex }) });
      onJob(response.job); return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Save failed.'); return false; }
    finally { setSaving(''); }
  }
  async function recut() { if (!await save()) return; setSaving('Cutting…'); try { const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}/cut`, { method: 'POST' }); onJob(response.job); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Cut failed.'); } finally { setSaving(''); } }
  async function tts() { if (!await save()) return; setSaving('Voice…'); try { const response = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); onJob(response.job); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Voice failed.'); } finally { setSaving(''); } }
  return <details className={`q-card ${q.confidence < .72 ? 'low' : ''}`} open={q.number === 1}>
    <summary><span className="q-num">Q{String(q.number).padStart(2,'0')}</span><div><strong>{q.type.replaceAll('_',' ')}{q.sourceNumber !== q.number ? ` · source Q${q.sourceNumber}` : ''}</strong><small>{formatTime(q.start)}–{formatTime(q.end)} · {Math.round(q.confidence * 100)}% · {q.boundarySource}</small></div><span className="q-status">{q.ttsAudioUrl ? 'TTS ✓' : q.sourceAudioUrl ? 'Source ✓' : 'Not cut'}</span></summary>
    <div className="q-body">
      <div className="audio-previews">{q.sourceAudioUrl && <div><b>Source preview</b><audio controls src={media(q.sourceAudioUrl, job.updatedAt)} /></div>}{q.ttsAudioUrl && <div><b>Generated preview</b><audio controls src={media(q.ttsAudioUrl, job.updatedAt)} /><a href={q.ttsAudioUrl} download={`Q${String(q.number).padStart(2, '0')}.mp3`}>Download Audio</a></div>}</div>
      <div className="time-row"><label>Start<input type="number" step="0.01" value={draft.start} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })} /></label><label>End<input type="number" step="0.01" value={draft.end} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })} /></label><label>Type<select value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as ListeningQuestion['type'] })}><option value="dialogue">Dialogue</option><option value="conversation">Conversation</option><option value="monologue">Monologue</option><option value="announcement">Announcement</option><option value="question_only">Question only</option><option value="spoken_choices">Spoken choices</option><option value="image_choice">Image choice</option><option value="number">Number</option><option value="unknown">Unknown</option></select></label></div>
      <label className="wide">Transcript<textarea value={draft.transcript} onChange={event => setDraft({ ...draft, transcript: event.target.value })} /></label>
      <label className="wide">TTS Script<textarea value={draft.script} onChange={event => setDraft({ ...draft, script: event.target.value })} placeholder="남자: ...\n여자: ..." /></label>
      <label className="wide">Question Text<input value={draft.questionText} onChange={event => setDraft({ ...draft, questionText: event.target.value })} /></label>
      <div className="choices">{choices.map((choice, index) => <label key={index}><span>{index + 1}</span><input value={choice} onChange={event => { const next = [...choices]; next[index] = event.target.value; setDraft({ ...draft, choices: next }); }} /></label>)}</div>
      <label>Correct Answer<select value={draft.correctAnswerIndex ?? ''} onChange={event => setDraft({ ...draft, correctAnswerIndex: event.target.value === '' ? null : Number(event.target.value) })}><option value="">Not set</option>{[0,1,2,3].map(index => <option key={index} value={index}>{index + 1}</option>)}</select></label>
      {!!q.flags.length && <div className="flags">{q.flags.map(flag => <span key={flag}>{flag}</span>)}</div>}{error && <p className="inline-error">{error}</p>}
      <div className="actions"><button className="secondary" onClick={save} disabled={!!saving}>{saving || 'Save'}</button>{q.sourceAudioUrl && <a className="secondary button-link" href={q.sourceAudioUrl}>Preview Source</a>}{job.sourceAudioUrl && <button className="secondary" onClick={recut} disabled={!!saving}>Re-cut Source</button>}<button className="primary" onClick={tts} disabled={!!saving || !draft.script.trim() || (profile.provider === 'gemini' && !profile.geminiApiKey.trim())}>Generate Voice</button>{(q.ttsAudioUrl || q.sourceAudioUrl) && <a className="secondary button-link" href={q.ttsAudioUrl || q.sourceAudioUrl || ''} download>Download Audio</a>}</div>
    </div>
  </details>;
}

function VoiceStudio({ status, profile, setProfile, rememberGeminiKey, setRememberGeminiKey, onGenerateAll, onTest, testJob }: { status: Status | null; profile: VoiceProfile; setProfile: (profile: VoiceProfile) => void; rememberGeminiKey: boolean; setRememberGeminiKey: (value: boolean) => void; onGenerateAll: () => void; onTest: () => void; testJob: ListeningJob | null }) {
  const voices = status?.voices ?? [];
  const geminiVoices = status?.geminiTts?.voices ?? ['Kore','Charon','Aoede','Puck'];
  const geminiModels = status?.geminiTts?.models ?? ['gemini-3.1-flash-tts-preview','gemini-2.5-flash-preview-tts','gemini-2.5-pro-preview-tts'];
  const selectWindows = (key: 'narratorVoice'|'maleVoice'|'femaleVoice', label: string) => <label>{label}<select value={profile[key]} onChange={event => setProfile({ ...profile, [key]: event.target.value })}><option value="">System default</option>{voices.map(voice => <option key={`${key}-${voice.name}`} value={voice.name}>{voice.name} · {voice.culture} · {voice.gender}</option>)}</select></label>;
  const selectGemini = (key: 'geminiNarratorVoice'|'geminiMaleVoice'|'geminiFemaleVoice', label: string) => <label>{label}<select value={profile[key]} onChange={event => setProfile({ ...profile, [key]: event.target.value })}>{geminiVoices.map(voice => <option key={`${key}-${voice}`} value={voice}>{voice}</option>)}</select></label>;
  const geminiBlocked = profile.provider === 'gemini' && !profile.geminiApiKey.trim();
  return <section className="card">
    <div className="card-head"><div><small>04 VOICE STUDIO</small><h2>Customize regenerated listening audio</h2></div><span className="pill">{profile.provider === 'gemini' ? 'Gemini API TTS' : 'Windows local TTS'}</span></div>
    <div className="voice-provider"><label>Provider<select value={profile.provider} onChange={event => setProfile({ ...profile, provider: event.target.value as VoiceProfile['provider'] })}><option value="gemini">Gemini TTS</option><option value="windows">Windows Local TTS</option></select></label></div>
    {profile.provider === 'gemini' ? <><div className="gemini-settings"><label className="wide">Gemini API Key<input type="password" autoComplete="off" value={profile.geminiApiKey} onChange={event => setProfile({ ...profile, geminiApiKey: event.target.value })} placeholder="Paste Google AI Studio API key" /></label><label className="remember-key"><input type="checkbox" checked={rememberGeminiKey} onChange={event => setRememberGeminiKey(event.target.checked)} /> Remember only in this browser on this Windows PC</label><p className="muted">The key is used only for local requests to Gemini. It is never saved in job.json, diagnostics, logs, Git, or exports.</p></div><div className="voice-grid"><label>Model<select value={profile.geminiModel} onChange={event => setProfile({ ...profile, geminiModel: event.target.value as VoiceProfile['geminiModel'] })}>{geminiModels.map(model => <option key={model} value={model}>{model}</option>)}</select></label>{selectGemini('geminiNarratorVoice','Narrator Voice')}{selectGemini('geminiMaleVoice','Male Voice')}{selectGemini('geminiFemaleVoice','Female Voice')}<label className="wide">Speaking Style / Direction<textarea value={profile.geminiStyle} onChange={event => setProfile({ ...profile, geminiStyle: event.target.value })} /></label></div></> : <div className="voice-grid">{selectWindows('narratorVoice','Narrator Voice')}{selectWindows('maleVoice','Male Voice')}{selectWindows('femaleVoice','Female Voice')}</div>}
    <div className="voice-grid"><label>Speed<input type="range" min="-10" max="10" value={profile.rate} onChange={event => setProfile({ ...profile, rate: Number(event.target.value) })} /><b>{profile.rate}</b></label><label>Pitch (post-processing)<input type="range" min="-6" max="6" step="1" value={profile.pitch} onChange={event => setProfile({ ...profile, pitch: Number(event.target.value) })} /><b>{profile.pitch}</b></label><label>Volume<input type="range" min="0" max="100" value={profile.volume} onChange={event => setProfile({ ...profile, volume: Number(event.target.value) })} /><b>{profile.volume}</b></label><label>Pause between lines (ms)<input type="number" min="0" max="3000" value={profile.pauseMs} onChange={event => setProfile({ ...profile, pauseMs: Number(event.target.value) })} /></label></div>
    <div className="actions"><button className="secondary" onClick={onTest} disabled={geminiBlocked}>Test {profile.provider === 'gemini' ? 'Gemini' : 'Windows'}</button><button className="primary large" onClick={onGenerateAll} disabled={geminiBlocked}>Generate All Q1–Q20</button></div>
    {testJob?.questions[0]?.ttsAudioUrl && <div className="audio-result"><audio controls src={media(testJob.questions[0].ttsAudioUrl, testJob.updatedAt)} /><a href={testJob.questions[0].ttsAudioUrl} download="voice-test.mp3">Download test</a></div>}{testJob?.error && <ErrorPanel error={testJob.error} />}
    {geminiBlocked && <p className="muted">Paste your Gemini API key to enable Gemini voice generation.</p>}{profile.provider === 'windows' && !voices.some(voice => /^ko/i.test(voice.culture)) && <p className="muted">No Korean Windows System.Speech voice was detected. Windows Settings → Time & language → Language & region → Korean → Language options → install Speech, restart the app, then retry; or use Gemini TTS.</p>}
  </section>;
}

function Logs({ job }: { job: ListeningJob }) { return <section className="card logs"><div className="card-head"><div><small>DIAGNOSTICS</small><h2>Sanitized Processing Log</h2></div><span className="pill">{job.logs.length} events</span></div><div className="log-box">{[...job.logs].reverse().slice(0, 80).map(log => <div key={log.id} className={log.level}><time>{new Date(log.timestamp).toLocaleTimeString()}</time><b>{log.question ? `Q${String(log.question).padStart(2, '0')}` : log.agent}</b><span>{log.message}</span><em>{log.percent}%</em></div>)}</div></section>; }
function formatTime(seconds: number) { const minutes = Math.floor(seconds / 60); const remainder = seconds - minutes * 60; return `${String(minutes).padStart(2,'0')}:${remainder.toFixed(2).padStart(5,'0')}`; }
