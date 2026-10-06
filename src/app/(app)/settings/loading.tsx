const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border flex h-[2.75rem] shrink-0 items-center border-b px-4">
      <span className="skeleton block h-2.5 w-16 rounded-full" />
    </div>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
      {[3, 4].map((rows, s) => (
        <div key={s} className="surface-card overflow-hidden">
          <div className="border-border flex flex-col gap-2 border-b px-4 py-3 md:px-5">
            <span className="skeleton block h-2.5 w-20 rounded-full" />
            <span className="skeleton block h-2 w-3/4 rounded-full opacity-70" />
          </div>
          <div className="flex flex-col gap-2 px-4 py-4 md:px-5">
            {Array.from({ length: rows }, (_, i) => (
              <span key={i} className="skeleton block h-10 w-full rounded-md opacity-60" />
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
)

export default Loading
