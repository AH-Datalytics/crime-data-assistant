// Shared header, hero, ask bar, footer and the mockup switcher. Mockup only.
export function shell({ title = "Crime Data Assistant", meta = "FBI NIBRS, 2017 to September 2026", ask = "", screen = "", downloads = false, bar = true } = {}) {
  const screens = [["05-explorer", "Explorer"], ["01-answer", "Answer"], ["02-clarify", "Clarify"], ["03-decline", "Decline"], ["04-follow-up", "Follow-up"]];
  document.body.insertAdjacentHTML("afterbegin", `
  <header class="Header"><div class="HeaderInner">
    <a class="Logo" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="#2A2A2A" stroke-width="2.2"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 3"/></svg><span>CRIME INDEX</span></a>
    <nav class="HeaderNav"><a href="#">Current Trends</a><a href="#">Historical Data Library</a><a href="#" class="active">Crime Data Assistant</a></nav>
    <div class="HeaderMenu"><svg width="18" height="18" viewBox="0 0 18 18" stroke="#575757" stroke-width="1.5"><path d="M2 5h14M2 9h14M2 13h14"/></svg>Menu</div>
  </div></header>
  <section class="Hero"><div class="HeroInner"><h1>${title}</h1><div class="HeroMeta">${meta}</div></div></section>
  ${bar ? "" : "<!--"}<div class="Ask"><div class="AskInner">
    <span class="overline">Ask</span><input class="AskInput" value="${ask ?? ""}" placeholder="Ask a question, like shoplifting in Memphis by month in 2024"><button class="Btn Btn-filled">Ask</button>
    <div class="AskRight">${downloads ? `Download <button class="Btn Btn-outlined">Data</button><button class="Btn Btn-outlined">Image</button>` : `<span class="mono">January 2017 to September 2026, 23,739 agencies</span>`}</div>
  </div></div>${bar ? "" : "-->"}`);
  document.body.insertAdjacentHTML("beforeend", `
  <footer class="Footer"><div class="FooterInner">
    <div class="idx"><a href="#">Current Trends</a><a href="#">Historical Data Library</a><a href="#">Crime Data Assistant</a><a href="#">Methodology</a><a href="#">About</a></div>
    <div class="cred">A project of AH Datalytics</div>
  </div></footer>
  <div class="Mock">${screens.map(([f, n]) => `<a href="${f}.html" class="${screen === f ? "on" : ""}">${n}</a>`).join("")}</div>`);
}
