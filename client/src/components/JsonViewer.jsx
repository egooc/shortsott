export default function JsonViewer({ title, data }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      <pre className="max-h-[420px] overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
        {JSON.stringify(data, null, 2)}
      </pre>
    </section>
  );
}
