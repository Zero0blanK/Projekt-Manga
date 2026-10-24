export function ReaderProgressBar({
  page,
  totalPages,
  onSeek,
}: {
  page: number;
  totalPages: number;
  onSeek: (page: number) => void;
}) {
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className="border-t border-white/10 bg-black/80 px-6 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-4 text-xs text-white/60">
        <span className="tabular-nums">
          {page} / {totalPages}
        </span>
        <div className="flex flex-1 items-center gap-0.5">
          {pages.map((p) => (
            <button
              key={p}
              onClick={() => onSeek(p)}
              aria-label={`Go to page ${p}`}
              className={`h-1 flex-1 rounded-full transition ${
                p <= page ? 'bg-primary' : 'bg-white/10 hover:bg-white/20'
              }`}
            />
          ))}
        </div>
        <span className="tabular-nums text-white/40">{Math.round((page / totalPages) * 100)}%</span>
      </div>
    </div>
  );
}
