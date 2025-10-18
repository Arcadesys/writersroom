# Streaming Progress from Model Reasoning

## Overview

The "Ask the writers" feature now streams real-time progress updates directly from the AI model's reasoning/thinking process, rather than using hardcoded client-side messages.

## Implementation Details

### Streaming API Integration

**Changed:** The OpenAI API call now uses streaming mode with reasoning tokens:

```typescript
{
  model: "gpt-4o",
  stream: true,
  stream_options: {
    include_usage: true
  }
}
```

### Real-Time Reasoning Display

As the model processes the text, it emits `reasoning_content` deltas that contain its actual editorial thinking:

- "Scanning for rhythm inconsistencies..."
- "Line 5: good sensory detail here"
- "Considering replacement for awkward phrasing on line 12"
- etc.

These updates appear in the sidebar progress log as the model works, giving writers insight into the editorial process.

### Throttling

Reasoning updates are throttled to 400ms intervals to prevent UI flooding while maintaining responsive feedback.

### System Prompt

The system prompt now explicitly instructs the model:

> "Use your reasoning/thinking process to narrate your editorial thought process as you work. Share brief observations about what you notice (rhythm issues, sensory opportunities, pacing concerns) as you read through the text."

## Progress Stages

1. **"Sending your note to the Writers…"** - Initial setup
2. **[Model's reasoning stream]** - Real-time editorial observations from the AI
3. **"Compiling the Writers response…"** - Parsing response
4. **"Validating and saving the edits…"** - Final processing
5. **Success/Error message** - Completion status

## Removed

- Hardcoded ambient messages (`requestProgressAmbientMessages`)
- Progress ticker that rotated fake messages (`scheduleRequestProgressTicker`)
- Client-side message rotation logic

## Benefits

1. **Authentic transparency**: Users see what the AI is actually thinking
2. **Educational**: Writers learn about editorial perspectives
3. **Confidence**: Visible progress reduces anxiety during long operations
4. **Debuggability**: Reasoning traces help understand unexpected results

## Model Support

Requires OpenAI models with reasoning/thinking token support:
- ✅ `gpt-4o` (used by default)
- ✅ `o1-preview`, `o1-mini` (when available)
- ❌ Older models without reasoning support will fall back gracefully

## UX Impact

Before: Generic "Asking the Writers..." with frozen UI feeling
After: Live stream of editorial observations showing active processing
