import { useEffect, useMemo, useState } from 'react';
import type { DiagnosticError, ListeningJob, ListeningQuestion, ToolStatus, VoiceProfile } from '../shared';

type SystemVoice = { name: string; culture: string; gender: string };
type Status = { version: string; tools: ToolStatus; voices: SystemVoice[] };
type SourceMode = 'youtube' | 'upload' | 'text';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let data: any = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data as T;
}

function media(url: string | null) { return url ? `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}` : ''; }
const defaultProfile: VoiceProfile = { narratorVoice: '', maleVoice: '', femaleVoice: '', rate: 0, pitch: 0, volume: 100, pauseMs: 450 };

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<SourceMode>('youtube');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [numberedText, setNumberedText] = useState('');
  const [job, setJob] = useState<ListeningJob | null>(null);
  const [profile, setProfile] = useState<VoiceProfile>(defaultProfile);
  const [busy, setBusy] = useState('');
  const [topError, setTopError] = useState('');
  const [customText, setCustomText] = useState('');
  const [customJob, setCustomJob] = useState<ListeningJob | null>(null);

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => {
    if (!status?.voices.length) return;
    const korean = status.voices.filter(v => /^ko/i.test(v.culture));
    const first = (korean[0] ?? status.voices[0])?.name ?? '';
    const male = (korean.find(v => /male/i.test(v.gender)) ?? korean[0] ?? status.voices[0])?.name ?? first;
    const female = (korean.find(v => /female/i.test(v.gender)) ?? korean[0] ?? status.voices[0])?.name ?? first;
    setProfile(p => p.narratorVoice ? p : { ...p, narratorVoice: female, maleVoice: male, femaleVoice: female });
  }, [status?.voices.length]);

  async function refreshStatus() {
    try { const r = await api<{ ok: true; version: string; tools: ToolStatus; voices: SystemVoice[] }>('/api/status'); setStatus(r); } catch (e) { setTopError(e instanceof Error ? e.message : 'Status failed.'); }
  }

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setInterval(() => void pollJob(job.id, setJob), 700);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!customJob || !['queued', 'running'].includes(customJob.status)) return;
    const timer = window.setInterval(() => void pollJob(customJob.id, setCustomJob), 700);
    return () => window.clearInterval(timer);
  }, [customJob?.id, customJob?.status]);

  async function pollJob(id: string, setter: (job: ListeningJob) => void) {
    try { const r = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${id}`); setter(r.job); } catch {}
  }

  async function start() {
    setTopError(''); setBusy('Starting…'); setJob(null);
    try {
      if (mode === 'youtube') {
        const r = await api<{ ok: true; job: ListeningJob }>('/api/jobs/youtube', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); setJob(r.job);
      } else if (mode === 'upload') {
        if (!file) throw new Error('Choose an audio/video file first.');
        const body = new FormData(); body.append('file', file);
        const r = await api<{ ok: true; job: ListeningJob }>('/api/jobs/upload', { method: 'POST', body }); setJob(r.job);
      } else {
        const r = await api<{ ok: true; job: ListeningJob }>('/api/jobs/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: numberedText }) }); setJob(r.job);
      }
    } catch (e) { setTopError(e instanceof Error ? e.message : 'Could not start.'); }
    finally { setBusy(''); }
  }

  async function generateAll() {
    if (!job) return; setTopError(''); setBusy('Voice generation started…');
    try { const r = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/tts-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); setJob(r.job); }
    catch (e) { setTopError(e instanceof Error ? e.message : 'Voice generation failed.'); }
    finally { setBusy(''); }
  }

  async function exportFinal() {
    if (!job) return; setBusy('Building final package…'); setTopError('');
    try { const r = await api<{ ok: true; job: ListeningJob; downloadUrl: string }>(`/api/jobs/${job.id}/export`, { method: 'POST' }); setJob(r.job); window.location.href = r.downloadUrl; }
    catch (e) { setTopError(e instanceof Error ? e.message : 'Export failed.'); }
    finally { setBusy(''); }
  }

  async function customVoice() {
    if (!customText.trim()) return; setBusy('Generating custom voice…'); setTopError('');
    try { const r = await api<{ ok: true; job: ListeningJob }>('/api/custom-voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: customText, profile }) }); setCustomJob(r.job); }
    catch (e) { setTopError(e instanceof Error ? e.message : 'Custom voice failed.'); }
    finally { setBusy(''); }
  }

  const readyQuestions = job?.questions.filter(q => q.script.trim()).length ?? 0;

  return <div className="shell">
    <header className="topbar">
      <div><span className="brand">MT</span><div><h1>EPS TOPIK Listening Factory</h1><p>YouTube / audio / Korean text → transcript → Q1–Q20 → customized voice → final package</p></div></div>
      <div className="tool-row"><Tool name="FFmpeg" ok={status?.tools.ffmpeg}/><Tool name="yt-dlp" ok={status?.tools.ytdlp}/><Tool name="Whisper" ok={status?.tools.whisper}/><span className="version">v{status?.version ?? '1.0.0'}</span></div>
    </header>

    {topError && <div className="toast-error">{topError}</div>}
    {busy && <div className="busy"><span className="spinner" />{busy}</div>}

    <main>
      <section className="card source-card">
        <div className="card-head"><div><small>01 SOURCE</small><h2>Start Listening Job</h2></div><span className="pill">No video AI calls</span></div>
        <div className="tabs">{(['youtube','upload','text'] as SourceMode[]).map(m => <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m === 'youtube' ? 'YouTube URL' : m === 'upload' ? 'Audio / Video File' : 'Q1–Q20 Text'}</button>)}</div>
        {mode === 'youtube' && <input className="big-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." />}
        {mode === 'upload' && <label className="file-drop"><input type="file" accept="audio/*,video/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /><strong>{file?.name ?? 'Choose MP3 / WAV / MP4 / M4A / WebM'}</strong><span>Local processing with FFmpeg + Whisper</span></label>}
        {mode === 'text' && <textarea className="source-text" value={numberedText} onChange={e => setNumberedText(e.target.value)} placeholder={'Q1: 남자: ...\n여자: ...\n\nQ2: ...\n\n... Q20:'} />}
        <button className="primary large" onClick={start} disabled={!!busy || (mode === 'youtube' && !url.trim()) || (mode === 'upload' && !file) || (mode === 'text' && !numberedText.trim())}>ANALYZE LISTENING</button>
      </section>

      {job && <>
        <Progress job={job} />
        {job.error && <ErrorPanel error={job.error} />}
        {!!job.warnings.length && <section className="card warning-card"><h3>Review warnings</h3>{job.warnings.map(w => <p key={w}>⚠ {w}</p>)}</section>}
        {!!job.transcript.length && <TranscriptPanel job={job} />}
        {!!job.questions.length && <section className="card">
          <div className="card-head"><div><small>03 Q1–Q20</small><h2>Question Audio Boundaries</h2></div><span className="pill">{readyQuestions}/{job.questions.length} scripts</span></div>
          <p className="muted">Explicit “1번…20번” markers get the highest confidence. Interpolated/low-confidence timestamps are editable. Play each clip, adjust start/end, then Re-cut.</p>
          <div className="question-list">{job.questions.map(q => <QuestionCard key={q.number} job={job} q={q} profile={profile} onJob={setJob} />)}</div>
        </section>}
        {!!job.questions.length && <VoiceStudio status={status} profile={profile} setProfile={setProfile} onGenerateAll={generateAll} />}
        {!!job.questions.length && <section className="card export-card">
          <div><small>05 FINAL</small><h2>Export Listening Package</h2><p>Uses customized TTS audio when available; otherwise uses the cut source clip.</p></div>
          <button className="primary large" onClick={exportFinal} disabled={!!busy || job.status === 'failed'}>DOWNLOAD FINAL ZIP</button>
          {job.exportUrl && <a className="download-link" href={job.exportUrl}>Download again</a>}
        </section>}
        <Logs job={job} />
      </>}

      <section className="card custom-card">
        <div className="card-head"><div><small>EXTRA</small><h2>Custom Korean Text → Voice</h2></div><span className="pill">No YouTube needed</span></div>
        <textarea value={customText} onChange={e => setCustomText(e.target.value)} placeholder={'남자: 오늘 몇 시에 출근합니까?\n여자: 아침 여덟 시에 출근합니다.'} />
        <button className="secondary" onClick={customVoice} disabled={!customText.trim() || !!busy}>Generate Custom Voice</button>
        {customJob?.questions[0]?.ttsAudioUrl && <div className="audio-result"><audio controls src={media(customJob.questions[0].ttsAudioUrl)} /><a href={customJob.questions[0].ttsAudioUrl} download>Download MP3</a></div>}
        {customJob?.error && <ErrorPanel error={customJob.error} />}
      </section>
    </main>
  </div>;
}

function Tool({ name, ok }: { name: string; ok: boolean | undefined }) { return <span className={`tool ${ok ? 'ok' : 'off'}`}><i />{name}</span>; }

function Progress({ job }: { job: ListeningJob }) {
  const blocks = Array.from({ length: 10 }, (_, i) => (i + 1) * 10 <= job.percent);
  const stages = ['Download','Normalize','Transcript','Split Q1–Q20','Cut Audio','Voice','Export'];
  return <section className="card progress-card">
    <div className="progress-title"><div><small>02 PROGRESS</small><h2>{job.currentAgent}</h2><p>{job.logs.at(-1)?.message ?? job.stage}</p></div><strong>{job.percent}%</strong></div>
    <div className="block-progress">{blocks.map((on, i) => <span key={i} className={on ? 'on' : ''} />)}</div>
    <div className="stage-row">{stages.map((s, i) => <span key={s} className={job.percent >= [8,25,40,50,58,82,96][i] ? 'done' : ''}>{job.percent >= [8,25,40,50,58,82,96][i] ? '✓' : '○'} {s}</span>)}</div>
    {job.currentQuestion && <div className="current-q">Current Q{job.currentQuestion}</div>}
  </section>;
}

function ErrorPanel({ error }: { error: DiagnosticError }) {
  return <section className="card error-panel"><div className="error-title"><span>ERROR</span><strong>{error.code}</strong></div><div className="error-grid"><label>Agent<b>{error.agent}</b></label><label>Stage<b>{error.stage}</b></label><label>File<b>{error.file ?? 'runtime'}</b></label><label>Line<b>{error.line ?? '—'}</b></label></div><h3>{error.reason}</h3><div className="fix"><strong>FIX</strong>{error.fix}</div>{error.detail && <details><summary>Technical detail</summary><pre>{error.detail}</pre></details>}</section>;
}

function TranscriptPanel({ job }: { job: ListeningJob }) {
  return <section className="card"><div className="card-head"><div><small>TRANSCRIPT</small><h2>{job.transcriptSource === 'caption' ? 'YouTube timestamped captions' : job.transcriptSource === 'whisper' ? 'Whisper timestamp transcript' : 'Text source'}</h2></div><span className="pill">{job.transcript.length} segments</span></div><div className="transcript-box">{job.transcript.map((s, i) => <p key={`${s.start}-${i}`}><time>{formatTime(s.start)} → {formatTime(s.end)}</time><span>{s.text}</span></p>)}</div></section>;
}

function QuestionCard({ job, q, profile, onJob }: { job: ListeningJob; q: ListeningQuestion; profile: VoiceProfile; onJob: (j: ListeningJob) => void }) {
  const [draft, setDraft] = useState(q);
  const [saving, setSaving] = useState('');
  useEffect(() => setDraft(q), [q.start, q.end, q.script, q.ttsAudioUrl, q.sourceAudioUrl, q.type, q.correctAnswerIndex]);
  const choices = Array.from({ length: 4 }, (_, i) => draft.choices[i] ?? '');
  async function save() {
    setSaving('Saving…');
    try { const r = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: Number(draft.start), end: Number(draft.end), type: draft.type, transcript: draft.transcript, script: draft.script, questionText: draft.questionText, choices, correctAnswerIndex: draft.correctAnswerIndex }) }); onJob(r.job); }
    finally { setSaving(''); }
  }
  async function recut() { setSaving('Cutting…'); await save(); try { const r = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}/cut`, { method: 'POST' }); onJob(r.job); } finally { setSaving(''); } }
  async function tts() { setSaving('Voice…'); await save(); try { const r = await api<{ ok: true; job: ListeningJob }>(`/api/jobs/${job.id}/questions/${q.number}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); onJob(r.job); } finally { setSaving(''); } }
  const audio = q.ttsAudioUrl || q.sourceAudioUrl;
  return <details className={`q-card ${q.confidence < .6 ? 'low' : ''}`} open={q.number === 1}>
    <summary><span className="q-num">Q{String(q.number).padStart(2,'0')}</span><div><strong>{q.type.replaceAll('_',' ')}</strong><small>{formatTime(q.start)}–{formatTime(q.end)} · {Math.round(q.confidence * 100)}% · {q.boundarySource}</small></div><span className="q-status">{q.ttsAudioUrl ? 'TTS ✓' : q.sourceAudioUrl ? 'Source ✓' : 'No audio'}</span></summary>
    <div className="q-body">
      {audio && <audio controls src={media(audio)} />}
      <div className="time-row"><label>Start<input type="number" step="0.01" value={draft.start} onChange={e => setDraft({ ...draft, start: Number(e.target.value) })} /></label><label>End<input type="number" step="0.01" value={draft.end} onChange={e => setDraft({ ...draft, end: Number(e.target.value) })} /></label><label>Type<select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as ListeningQuestion['type'] })}><option value="dialogue">Dialogue</option><option value="monologue">Monologue</option><option value="question_only">Question only / visual choices</option><option value="spoken_choices">Question + spoken choices</option><option value="image_choice">Image choice</option><option value="unknown">Unknown</option></select></label></div>
      <label className="wide">Transcript<textarea value={draft.transcript} onChange={e => setDraft({ ...draft, transcript: e.target.value })} /></label>
      <label className="wide">TTS Script<textarea value={draft.script} onChange={e => setDraft({ ...draft, script: e.target.value })} placeholder="남자: ...\n여자: ..." /></label>
      <label className="wide">Visual question text (optional)<input value={draft.questionText} onChange={e => setDraft({ ...draft, questionText: e.target.value })} /></label>
      <div className="choices">{choices.map((c, i) => <label key={i}><span>{i + 1}</span><input value={c} onChange={e => { const next = [...choices]; next[i] = e.target.value; setDraft({ ...draft, choices: next }); }} /></label>)}</div>
      <label>Correct answer<select value={draft.correctAnswerIndex ?? ''} onChange={e => setDraft({ ...draft, correctAnswerIndex: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Not set</option>{[0,1,2,3].map(i => <option key={i} value={i}>{i + 1}</option>)}</select></label>
      {!!q.flags.length && <div className="flags">{q.flags.map(f => <span key={f}>{f}</span>)}</div>}
      <div className="actions"><button className="secondary" onClick={save} disabled={!!saving}>{saving || 'Save'}</button>{job.sourceAudioUrl && <button className="secondary" onClick={recut} disabled={!!saving}>Re-cut Source</button>}<button className="primary" onClick={tts} disabled={!!saving || !draft.script.trim()}>Generate Voice</button></div>
    </div>
  </details>;
}

function VoiceStudio({ status, profile, setProfile, onGenerateAll }: { status: Status | null; profile: VoiceProfile; setProfile: (p: VoiceProfile) => void; onGenerateAll: () => void }) {
  const voices = status?.voices ?? [];
  const select = (key: 'narratorVoice'|'maleVoice'|'femaleVoice', label: string) => <label>{label}<select value={profile[key]} onChange={e => setProfile({ ...profile, [key]: e.target.value })}><option value="">System default</option>{voices.map(v => <option key={`${key}-${v.name}`} value={v.name}>{v.name} · {v.culture} · {v.gender}</option>)}</select></label>;
  return <section className="card"><div className="card-head"><div><small>04 VOICE STUDIO</small><h2>Customize regenerated listening audio</h2></div><span className="pill">Windows local TTS</span></div><div className="voice-grid">{select('narratorVoice','Narrator')}{select('maleVoice','Male')}{select('femaleVoice','Female')}<label>Speed / Rate<input type="range" min="-10" max="10" value={profile.rate} onChange={e => setProfile({ ...profile, rate: Number(e.target.value) })} /><b>{profile.rate}</b></label><label>Pitch<input type="range" min="-6" max="6" step="1" value={profile.pitch} onChange={e => setProfile({ ...profile, pitch: Number(e.target.value) })} /><b>{profile.pitch}</b></label><label>Volume<input type="range" min="0" max="100" value={profile.volume} onChange={e => setProfile({ ...profile, volume: Number(e.target.value) })} /><b>{profile.volume}</b></label><label>Pause between lines (ms)<input type="number" min="0" max="3000" value={profile.pauseMs} onChange={e => setProfile({ ...profile, pauseMs: Number(e.target.value) })} /></label></div><button className="primary large" onClick={onGenerateAll}>GENERATE ALL AVAILABLE SCRIPTS</button>{!voices.length && <p className="muted">No Windows SAPI voices were detected. Source clips still work. Reopen the app after installing a Korean Windows voice to use TTS.</p>}</section>;
}

function Logs({ job }: { job: ListeningJob }) { return <section className="card logs"><div className="card-head"><div><small>DIAGNOSTICS</small><h2>Exact Processing Log</h2></div><span className="pill">{job.logs.length} events</span></div><div className="log-box">{[...job.logs].reverse().slice(0, 80).map(log => <div key={log.id} className={log.level}><time>{new Date(log.timestamp).toLocaleTimeString()}</time><b>{log.question ? `Q${log.question}` : log.agent}</b><span>{log.message}</span><em>{log.percent}%</em></div>)}</div></section>; }
function formatTime(seconds: number) { const m = Math.floor(seconds / 60); const s = seconds - m * 60; return `${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`; }
