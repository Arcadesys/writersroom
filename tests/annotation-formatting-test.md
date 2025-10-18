# Annotation Formatting Test

## Test Case 1: Simple Numbered List
**Input:**
```
[CHECKLIST: 1) Tighten flow and trim filler; 2) Mute pacing with slow word-structure tweaks; 3) Add light sensory detail where a single word will evoke; 4) Fix punctuation/em-dash spacing; 5) Maintain voice and highlight standout lines.]
```

**Expected Output:**
- Item "1)" should be on its own with proper spacing
- Item "2)" should be on its own line
- Items 3), 4), 5) should each be separate
- Numbers should be visually distinct (bolded/colored)
- Content should wrap properly

## Test Case 2: Mixed Text and List
**Input:**
```
Consider these improvements: 1) Add more sensory details; 2) Tighten the pacing; 3) Strengthen the ending. These changes will enhance the flow.
```

**Expected Output:**
- "Consider these improvements:" appears first
- Three numbered items appear with proper formatting
- "These changes will enhance the flow." appears at the end

## Test Case 3: No List (Plain Text)
**Input:**
```
This is a simple annotation without any numbered list.
```

**Expected Output:**
- Plain text display
- Italic styling
- No special list formatting

## Implementation Notes

The `formatAnnotationText()` function:
1. Detects numbered list patterns using regex: `/\d+\)\s/`
2. Splits text on numbered items while preserving structure
3. Creates separate divs for each list item
4. Applies special styling to numbers vs content
5. Falls back to plain text for non-list content

## CSS Classes Applied

- `.writersroom-annotation-formatted` - Container for all formatted annotation content
- `.writersroom-annotation-list-item` - Flex container for each numbered item
- `.writersroom-annotation-number` - The "1)", "2)" part (bold/accented)
- `.writersroom-annotation-content` - The actual text of the item
- `.writersroom-annotation-text-block` - For non-list text blocks
