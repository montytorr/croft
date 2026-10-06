/** Holds the 44px header and 42px filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
    <div className="border-border/70 flex h-[2.625rem] shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <span className="skeleton h-10 flex-1 rounded-md" />
      <span className="skeleton hidden h-9 w-24 rounded-md sm:block" />
      <span className="skeleton hidden h-9 w-24 rounded-md sm:block" />
    </div>
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="border-border/70 flex items-start gap-2.5 border-b px-4 py-2.5">
          <span className="skeleton mt-[0.1875rem] size-[0.8125rem] shrink-0 rounded" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="flex items-center gap-2">
              <span className="skeleton h-2 w-14 rounded-full" />
              <span className="skeleton h-[1rem] w-12 rounded-full opacity-70" />
            </span>
            <span className="skeleton h-2.5 rounded-full" style={{ width: `${72 - i * 4}%` }} />
          </span>
        </div>
      ))}
    </div>
  </div>
)

export default Loading
