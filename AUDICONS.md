# Audicons (Audio Icons) for Accessibility

## Overview

Writers Room now includes **audicons** - short, distinct audio cues that play when performing various actions. This feature improves accessibility for blind and low vision users, as well as providing helpful feedback for all users who benefit from audio confirmation of actions.

## What are Audicons?

Audicons are brief, non-intrusive sound effects that provide audio feedback for user interactions. They help users understand what's happening without needing to look at the screen, making the plugin more accessible to:

- Screen reader users
- Users with low vision
- Users who prefer multi-sensory feedback
- Users working in environments where visual confirmation might be difficult

## Audicon Types

The following actions trigger audicons:

### 1. **Selection** (Soft ascending tone)
- Plays when selecting an edit from the sidebar
- A gentle upward pitch indicates the focus has moved to a new edit
- Frequency: 440Hz → 660Hz over 80ms

### 2. **Apply** (Confident double-beep)
- Plays when an edit is applied to the document
- Two ascending tones confirm the successful application
- Frequencies: 523Hz (C5) → 659Hz (E5)
- Indicates a permanent change has been made

### 3. **Resolve** (Descending tone)
- Plays when an edit is dismissed/resolved without applying
- A gentle downward pitch indicates the edit has been removed
- Frequency: 660Hz → 440Hz over 80ms

### 4. **Request Start** (Ascending sweep)
- Plays when beginning to request new edits from the AI
- A rising sweep indicates the start of a background process
- Frequency: 330Hz → 880Hz over 150ms

### 5. **Request Complete** (Success chime)
- Plays when AI edits are successfully received
- Three ascending notes create a "success" melody
- Frequencies: 523Hz (C5) → 659Hz (E5) → 784Hz (G5)
- Indicates the process completed successfully

### 6. **Request Error** (Low warning tone)
- Plays when an AI request fails
- A lower, sawtooth wave indicates an error condition
- Frequency: 200Hz over 200ms
- Alerts the user that attention is needed

### 7. **Navigate Next** (Quick high blip)
- Reserved for future navigation features
- Quick high tone at 880Hz
- Would indicate moving forward through edits

### 8. **Navigate Previous** (Quick low blip)
- Reserved for future navigation features
- Quick lower tone at 660Hz
- Would indicate moving backward through edits

## Implementation Details

### Technology
- Uses the Web Audio API (`AudioContext`)
- Creates tones programmatically using oscillators
- No external audio files required
- Falls back gracefully if audio is unavailable

### Volume
- All audicons play at 15% volume (0.15 gain)
- Designed to be noticeable but not intrusive
- Won't interfere with screen readers or other audio

### Performance
- Minimal performance impact
- Sounds are generated on-demand, not stored
- Automatic cleanup of audio resources

## User Control

### Settings
Users can enable or disable audicons in the plugin settings:

1. Open Settings
2. Navigate to Writers Room
3. Toggle "Audible Feedback"

The setting is enabled by default but can be turned off if users find audio feedback distracting.

### Browser Compatibility
- Works in all modern browsers that support the Web Audio API
- Gracefully degrades if audio is unavailable
- No errors or warnings if audio fails to play

## Design Philosophy

### Accessibility First
Audicons are designed following Web Content Accessibility Guidelines (WCAG):
- Provide alternative feedback to visual-only interfaces
- Don't rely solely on audio (all actions also have visual feedback)
- Can be disabled for users who prefer no audio

### Non-Intrusive
- Short duration (40-240ms)
- Low volume
- Pleasant tones based on musical notes
- No jarring or harsh sounds

### Meaningful
- Each sound has a distinct character matching its purpose
- Ascending tones for positive/forward actions
- Descending tones for dismissal/backward actions
- Musical intervals create memorable patterns

## Future Enhancements

Potential improvements for audicon support:

1. **Customizable Sounds** - Allow users to choose from different sound sets
2. **Volume Control** - Adjustable volume in settings
3. **Keyboard Navigation Sounds** - Add audicons for keyboard-based edit navigation
4. **Status Announcements** - Longer audio cues for complex status changes
5. **Spatial Audio** - Use stereo positioning to indicate edit location

## Code Structure

### Key Classes

**`AudiconPlayer`**
- Manages AudioContext and sound generation
- `play(type)` - Plays a specific audicon
- `setEnabled(enabled)` - Toggles audicons on/off
- `dispose()` - Cleans up audio resources

### Integration Points

Audicons are triggered at these points in the code:

- `selectEdit()` - When an edit is selected
- `applySidebarEdit()` - After successfully applying an edit
- `resolveSidebarEdit()` - After dismissing an edit
- `requestAiEditsForFile()` - At request start, completion, or error

## Testing

To test audicons:

1. Enable "Audible Feedback" in settings
2. Open a note with Writers Room edits
3. Try these actions:
   - Click different edits in the sidebar (selection tone)
   - Apply an edit (double-beep)
   - Resolve/dismiss an edit (descending tone)
   - Request new edits (sweep, then chime or error)

## Resources

- [Web Audio API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [WCAG Audio Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html)
- [Musical Frequencies Reference](https://pages.mtu.edu/~suits/notefreqs.html)
