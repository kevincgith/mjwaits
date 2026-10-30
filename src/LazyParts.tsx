// Play, the online table, Scores and the rules sheet, loaded when first
// shown (see lib/lazyParts.ts). While one loads - a moment at most, once
// the page has fetched them at idle - a blank of its own background shows.
import { Component, lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { PlayHome as PlayHomeView } from "./PlayHome";
import type { PlayPanel as PlayPanelView } from "./PlayPanel";
import type { OnlineTable as OnlineTableView } from "./OnlineTable";
import type { ScoresPanel as ScoresPanelView, SharedScoresView as SharedScoresViewView } from "./ScoresPanel";
import type { TaiRulesSheet as TaiRulesSheetView } from "./TaiRulesSheet";
import { loadedPart, loadOnline, loadPlay, loadPlayHome, loadRulesSheet, loadScoresPanel, PartLoadError } from "./lib/lazyParts";

// `ready`: the part, if it's here already - then it's handed to React at
// once (a thenable that resolves on the spot), so it shows straight away
// rather than its blank for a frame.
function lazyPart<P>(ready: () => ComponentType<P> | undefined, load: () => Promise<ComponentType<P>>) {
  return lazy(() => {
    const part = ready();
    if (!part) return load().then((c) => ({ default: c }));
    return { then: (resolve: (m: { default: ComponentType<P> }) => void) => resolve({ default: part }) } as unknown as Promise<{ default: ComponentType<P> }>;
  });
}

// The start screen reads the saved game itself, so App needn't load Play
// to ask.
type PlayHomeProps = Omit<ComponentProps<typeof PlayHomeView>, "saved">;
const playHome = (home: typeof import("./PlayHome"), play: typeof import("./PlayPanel")) => (props: PlayHomeProps) => (
  <home.PlayHome {...props} saved={play.savedSummary()} />
);
const PlayHomeLazy = lazyPart(
  () => {
    const home = loadedPart("playHome");
    const play = loadedPart("play");
    return home && play ? playHome(home, play) : undefined;
  },
  () => Promise.all([loadPlayHome(), loadPlay()]).then(([home, play]) => playHome(home, play)),
);
const PlayPanelLazy = lazyPart(() => loadedPart("play")?.PlayPanel, () => loadPlay().then((m) => m.PlayPanel));
const OnlineTableLazy = lazyPart(() => loadedPart("online")?.OnlineTable, () => loadOnline().then((m) => m.OnlineTable));
const ScoresPanelLazy = lazyPart(() => loadedPart("scores")?.ScoresPanel, () => loadScoresPanel().then((m) => m.ScoresPanel));
const SharedScoresViewLazy = lazyPart(() => loadedPart("scores")?.SharedScoresView, () => loadScoresPanel().then((m) => m.SharedScoresView));
const TaiRulesSheetLazy = lazyPart(() => loadedPart("rules")?.TaiRulesSheet, () => loadRulesSheet().then((m) => m.TaiRulesSheet));

// A part that couldn't be fetched (no signal, and not stored yet): its
// blank, with a way to try again. Any other error goes on up, as before.
class LoadFailed extends Component<{ fallback: ReactNode; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!(error instanceof PartLoadError)) throw error;
    return (
      <>
        {this.props.fallback}
        <div className="update-bar" role="alert">
          <span>Couldn't open this - no connection?</span>
          <button type="button" className="update-bar-reload" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </>
    );
  }
}

function Part({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <LoadFailed fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadFailed>
  );
}

export function PlayHome(props: Omit<ComponentProps<typeof PlayHomeView>, "saved">) {
  return (
    <Part fallback={<div className="play-screen ph-screen" />}>
      <PlayHomeLazy {...props} />
    </Part>
  );
}

export function PlayPanel(props: ComponentProps<typeof PlayPanelView>) {
  return (
    <Part fallback={<div className="play-screen" />}>
      <PlayPanelLazy {...props} />
    </Part>
  );
}

export function OnlineTable(props: ComponentProps<typeof OnlineTableView>) {
  return (
    <Part fallback={<div className="play-screen ot-screen" />}>
      <OnlineTableLazy {...props} />
    </Part>
  );
}

// Tall enough that the footer doesn't jump up for the moment it's blank.
const scoresBlank = <section className="panel scores-panel" style={{ minHeight: "100vh" }} />;

export function ScoresPanel(props: ComponentProps<typeof ScoresPanelView>) {
  return (
    <Part fallback={scoresBlank}>
      <ScoresPanelLazy {...props} />
    </Part>
  );
}

export function SharedScoresView(props: ComponentProps<typeof SharedScoresViewView>) {
  return (
    <Part fallback={scoresBlank}>
      <SharedScoresViewLazy {...props} />
    </Part>
  );
}

export function TaiRulesSheet(props: ComponentProps<typeof TaiRulesSheetView>) {
  return (
    <Part fallback={null}>
      <TaiRulesSheetLazy {...props} />
    </Part>
  );
}
