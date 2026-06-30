export default function AudioPlayer({ src }) {
  if (!src) return null;
  return <audio controls className="w-full" src={src} />;
}
