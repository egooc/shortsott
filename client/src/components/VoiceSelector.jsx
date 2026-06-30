export default function VoiceSelector({ voices, value, onChange }) {
  return (
    <select className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Voice 선택</option>
      {voices.map((voice) => (
        <option value={voice.voice_id} key={voice.voice_id}>
          {voice.name}
        </option>
      ))}
    </select>
  );
}
