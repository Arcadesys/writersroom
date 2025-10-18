# Annotation List Formatting

## Before This Change
```
Line 4 · annotation
Category: Flow

# How It Was

[CHECKLIST: 1) Tighten flow and trim filler; 2) Mute pacing with slow word-structure tweaks; 3) Add light sensory detail where a single word will evoke; 4) Fix punctuation/em-dash spacing; 5) Maintain voice and highlight standout lines.]
```

**Problem:** Everything runs together, hard to parse individual items.

---

## After This Change
```
Line 4 · annotation
Category: Flow

# How It Was

┌─────────────────────────────────────────┐
│ 💭 WRITER'S NOTE:                       │
│                                         │
│ [CHECKLIST:                             │
│                                         │
│ 1) Tighten flow and trim filler         │
│                                         │
│ 2) Mute pacing with slow word-          │
│    structure tweaks                     │
│                                         │
│ 3) Add light sensory detail where a     │
│    single word will evoke               │
│                                         │
│ 4) Fix punctuation/em-dash spacing      │
│                                         │
│ 5) Maintain voice and highlight         │
│    standout lines                       │
└─────────────────────────────────────────┘
```

**Benefits:**
- ✅ Each item is visually separated
- ✅ Numbers are highlighted and easy to scan
- ✅ Text wraps properly within each item
- ✅ Clear hierarchy and readability
- ✅ Prefix text like "[CHECKLIST:" is preserved

---

## How It Works

### Detection
The system looks for patterns like:
- `1)` followed by text
- `2)` followed by text
- `3)` followed by text
- etc.

### Parsing
```typescript
// Split on numbered items: /(?=\d+\)\s)/
// This creates: ["[CHECKLIST: ", "1) First", "2) Second", "3) Third"]
```

### Rendering
Each numbered item becomes:
```html
<div class="writersroom-annotation-list-item">
  <span class="writersroom-annotation-number">1)</span>
  <span class="writersroom-annotation-content">Tighten flow and trim filler</span>
</div>
```

### Styling
- Numbers: Bold, accented color, fixed width
- Content: Flexible width, wraps naturally
- Container: Flexbox for perfect alignment

---

## Edge Cases Handled

### Case 1: Text before the list
```
Consider these points: 1) First 2) Second
```
Renders as:
```
Consider these points:
1) First
2) Second
```

### Case 2: Text after the list
```
1) First 2) Second. That's all!
```
Renders as:
```
1) First
2) Second. That's all!
```

### Case 3: No numbered list
```
Just a simple annotation without numbers.
```
Renders as plain text (no special formatting).

### Case 4: Complex prefixes
```
[CHECKLIST: 1) Item one 2) Item two]
```
"[CHECKLIST: " appears before the list, then items are formatted.

---

## CSS Breakdown

```css
.writersroom-annotation-list-item {
  display: flex;           /* Side-by-side layout */
  align-items: flex-start; /* Top-align number and text */
  margin: 0.4rem 0;        /* Spacing between items */
  gap: 0.5rem;             /* Space between number and text */
}

.writersroom-annotation-number {
  color: var(--text-accent);  /* Highlighted color */
  font-weight: 600;           /* Bold */
  flex-shrink: 0;             /* Don't shrink */
  min-width: 1.5rem;          /* Consistent alignment */
}

.writersroom-annotation-content {
  flex: 1;              /* Take remaining space */
  line-height: 1.4;     /* Comfortable reading */
}
```

This creates a clean, scannable list that's easy to read and act upon!
