/**
 * The sticker icon kit in web/public/art/icons (256x256 viewBox, flat fills, lower-right shading).
 * The first 28 are Body Double's fairy-tale kit; the last 10 were drawn for Dance Fantasy in the same style.
 */
export const ICON_NAMES = [
  'apple',
  'beanstalk',
  'castle',
  'clock-tower',
  'cottage',
  'cracked-mirror',
  'crown',
  'crystal-ball',
  'eat-me',
  'frog-prince',
  'golden-egg',
  'key',
  'lamp',
  'lantern',
  'map',
  'mirror',
  'potion',
  'pumpkin',
  'quill',
  'red-hood',
  'scroll',
  'slipper',
  'sparkles',
  'spindle',
  'storybook',
  'tree',
  'wand',
  'wolf',
  // Dance Fantasy additions
  'music-note',
  'dance-shoe',
  'trophy',
  'mirror-cam',
  'gear',
  'play',
  'pause',
  'party',
  'chat',
  'upload',
] as const

export type IconName = (typeof ICON_NAMES)[number]
