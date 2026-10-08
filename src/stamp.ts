// Local time with its offset, built by hand: toLocaleString varies by locale,
// and git and the terminal show local time. A log's section headers and its gate lines both use it, so one
// time zone reads down a gates log (src/run.ts and src/gates.ts share it; neither may import the other's module for it).
export const localStamp = (d = new Date()) => {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${offset < 0 ? "-" : "+"}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`;
};
