export default function ApiKeyInput({
  label,
  value,
  onChange,
  onSave,
  onTest,
  status,
  description = '',
  warning = '',
  testLabel = 'Test',
  saveLabel = 'Save'
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="mb-2 text-sm font-semibold text-slate-700">{label}</p>
      {description ? <p className="mb-2 text-xs text-slate-500">{description}</p> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type="password"
        />
        <button onClick={onTest} className="rounded-md border border-slate-300 px-3 py-2 text-sm">{testLabel}</button>
        <button onClick={onSave} className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white">{saveLabel}</button>
      </div>
      {warning ? <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</p> : null}
      {status ? <p className="mt-2 text-xs text-slate-600">{status}</p> : null}
    </div>
  );
}
