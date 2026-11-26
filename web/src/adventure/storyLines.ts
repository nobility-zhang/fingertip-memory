import type {
  AdventureLineView,
  AdventureNodeView,
} from '../api/contracts';

export interface StoryStanding {
  lia?: 'left' | 'right' | 'far-right';
  serin?: 'left' | 'right' | 'far-right';
}

export interface StoryLineRuntime {
  line: AdventureLineView;
  speakerName: string;
  standing: StoryStanding;
  choices: AdventureNodeView['choices'];
  advances: boolean;
}

const DEFAULT_STANDING: Required<StoryStanding> = {
  lia: 'left',
  serin: 'right',
};

const SPEAKER_ALIASES: Readonly<Record<string, 'lia' | 'serin' | 'fina' | 'narration'>> = {
  lia: 'lia',
  kind: 'lia',
  serin: 'serin',
  fina: 'fina',
  narration: 'narration',
};

export function lineAt(
  node: AdventureNodeView,
  displayName: (speaker: string) => string,
  lineIndex: number,
): StoryLineRuntime {
  const lines = node.lines as AdventureLineView[] | undefined ?? [];
  const authored = lines[Math.min(lineIndex, Math.max(0, lines.length - 1))];
  if (authored !== undefined) {
    const speakerKey = SPEAKER_ALIASES[authored.speaker]
      ?? (authored.portraitCharacterId === 'serin'
        ? 'serin'
        : authored.portraitCharacterId === 'fina'
          ? 'fina'
          : authored.portraitCharacterId === 'lia'
            ? 'lia'
            : authored.speaker === 'narration'
              ? 'narration'
              : 'lia');
    const speakerName = speakerKey === 'narration'
      ? '旁白'
      : displayName(speakerKey);
    return {
      line: authored,
      speakerName,
      standing: {
        lia: authored.stage?.lia ?? DEFAULT_STANDING.lia,
        serin: authored.stage?.serin ?? DEFAULT_STANDING.serin,
      },
      choices: node.choices,
      advances: lineIndex < lines.length - 1,
    };
  }
  const fallback: AdventureLineView = {
    lineId: `${node.nodeId}#text`,
    speaker: node.speaker,
    portraitCharacterId: node.portraitCharacterId,
    text: node.text,
    stage: {
      sceneId: node.sceneId,
    },
  };
  return {
    line: fallback,
    speakerName: node.speaker || displayName('lia'),
    standing: DEFAULT_STANDING,
    choices: node.choices,
    advances: false,
  };
}

export function lastLineIndex(node: AdventureNodeView): number {
  return Math.max(0, (node.lines?.length ?? 1) - 1);
}

export function storySceneId(
  node: AdventureNodeView,
  lineIndex: number,
): string | undefined {
  const line = node.lines?.[lineIndex];
  return line?.stage?.sceneId ?? node.sceneId;
}
