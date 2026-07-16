import { useCallback, useEffect, useState } from "react";

// GET com ciclo de vida: {data, loading, error, reload}
export function useResource(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.resolve(fetcher())
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => load(), [load]);
  return { data, loading, error, reload: load };
}

// Mutação imperativa: {run, pending, error}
export function useMutation(action) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  async function run(...args) {
    setPending(true);
    setError(null);
    try {
      return await action(...args);
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setPending(false);
    }
  }
  return { run, pending, error };
}
