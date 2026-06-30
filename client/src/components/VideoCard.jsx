export default function VideoCard({ video, onSelect }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h4 className="font-semibold text-slate-900">📹 {video.title || video.description?.slice(0, 40) || 'Untitled'}</h4>
      <p className="mt-1 text-sm text-slate-600">Creator: {video.creator || video.author || '-'}</p>
      <p className="text-sm text-slate-600">Views: {video.views || 0} | Likes: {video.likes || 0}</p>
      <p className="text-sm text-slate-600">Platform: {video.platform || '-'}</p>
      <button className="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm text-white" onClick={() => onSelect(video)}>
        → Phase 2 분석
      </button>
    </div>
  );
}
