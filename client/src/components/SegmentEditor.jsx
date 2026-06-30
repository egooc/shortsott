export default function SegmentEditor({ segments, onChangeSegment }) {
  return (
    <div className="space-y-3">
      {segments.map((segment) => (
        <div className="rounded-md border border-slate-200 p-3" key={segment.segment_id}>
          <p className="mb-1 text-xs text-slate-500">{segment.segment_id} ({segment.argument_part})</p>
          <textarea
            value={segment.narration}
            onChange={(e) => onChangeSegment(segment.segment_id, e.target.value)}
            className="h-20 w-full rounded-md border border-slate-300 p-2 text-sm"
          />
        </div>
      ))}
    </div>
  );
}
