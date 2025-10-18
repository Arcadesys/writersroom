# Color Schemes for Accessibility

## Overview

Writers Room now supports multiple color schemes to improve accessibility for users with different visual needs. Each scheme is designed with specific use cases in mind.

## Available Color Schemes

### 1. Default
The standard color scheme with balanced colors:
- **Addition**: Green tones
- **Replacement**: Orange tones  
- **Subtraction**: Red tones
- **Annotation**: Blue tones
- **Star**: Yellow/gold tones

**Best for**: General use with standard vision

### 2. High Contrast
Increased saturation and contrast for better visibility:
- Brighter, more vivid colors
- Stronger borders (0.6 opacity vs 0.3)
- Enhanced backgrounds (0.25 opacity vs 0.15)

**Best for**: 
- Users with low vision
- Bright screen environments
- Users who prefer bolder visual cues

### 3. Colorblind Friendly
Colors selected to work across all common types of color blindness (protanopia, deuteranopia, tritanopia):
- **Addition**: Blue (#0072B2)
- **Replacement**: Orange (#E69F00)
- **Subtraction**: Vermillion (#D55E00)
- **Annotation**: Sky blue (#56B4E9)
- **Star**: Yellow (#F0E442)
- **Active**: Reddish purple (#CC79A7)

Based on the [ColorBrewer](https://colorbrewer2.org/) palette which is scientifically designed for color vision deficiency.

**Best for**:
- Users with color blindness
- Maximum color differentiation
- Professional accessibility requirements

### 4. Muted (Low Eye Strain)
Softer, desaturated colors for extended reading/editing sessions:
- Lower contrast backgrounds (0.12 opacity)
- Gentler borders (0.25 opacity)
- Reduced saturation across all colors

**Best for**:
- Long editing sessions
- Users sensitive to bright colors
- Reducing digital eye strain
- Evening/night editing

### 5. Warm Tones
Colors from the warm end of the spectrum (reds, oranges, yellows):
- Creates a cohesive, warmer aesthetic
- All highlights use yellow/orange/red family

**Best for**:
- Personal preference for warm colors
- Matching warm editor themes
- Creating mood consistency

### 6. Cool Tones
Colors from the cool end of the spectrum (blues, greens, purples):
- Creates a cohesive, cooler aesthetic
- All highlights use blue/purple/cyan family

**Best for**:
- Personal preference for cool colors
- Matching cool editor themes
- Reducing visual warmth/harshness

## Implementation Details

### Color Palette Structure
Each scheme defines colors for:
```typescript
{
  addition: { bg: string; border: string };
  replacement: { bg: string; border: string };
  subtraction: { bg: string; border: string };
  annotation: { bg: string; border: string };
  star: { bg: string; border: string };
  hover: string;
  active: { bg: string; border: string };
}
```

### Dynamic Updates
- Changes apply immediately when selected in settings
- No need to reload Obsidian
- Both editor mode (line highlights) and preview mode (span highlights) update
- All open documents refresh automatically

## Accessibility Benefits

1. **Visual Acuity**: High contrast mode helps users with low vision
2. **Color Blindness**: Colorblind-friendly palette ensures all edit types are distinguishable
3. **Eye Strain**: Muted colors reduce fatigue during long sessions
4. **Personal Preference**: Multiple options allow users to choose what works best for them

## Testing Checklist

- [x] All 6 color schemes defined
- [x] Settings dropdown implemented
- [x] Dynamic style updates working
- [ ] Verify in light and dark Obsidian themes
- [ ] Test with actual colorblind users (simulation recommended)
- [ ] Ensure sufficient contrast ratios (WCAG AA minimum)
- [ ] Test on different monitor types (IPS, TN, OLED)

## Future Enhancements

Potential additions for future versions:
- Custom color scheme editor
- Import/export color schemes
- Per-file color scheme override
- Dark/light mode specific schemes
- WCAG contrast ratio display in settings
- Colorblindness simulation preview
