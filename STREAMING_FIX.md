# Streaming Progress Fix

## Problem
The writer's room sidebar was not showing progress updates while waiting for the model's response during the edit generation process.

## Root Cause
The streaming implementation had several issues:

1. **No fallback for models without reasoning content**: The progress updates only occurred when the model sent `reasoning_content` in the stream. Models like GPT-4 don't include reasoning content, so no progress would be displayed.

2. **Throttling was too aggressive**: Updates were throttled to every 400ms, which might have felt sluggish.

3. **No token count feedback**: Users had no indication that data was being received if the model didn't provide reasoning content.

## Solution Implemented

### 1. Enhanced Streaming Progress (Lines 2975-3070)
- **Added token counting**: Track the number of tokens received from the stream
- **Dual progress modes**:
  - If model provides `reasoning_content`: Display the latest sentence/clause from the reasoning
  - If no reasoning: Show periodic updates with token count every 1 second
- **Better throttling**: Reduced reasoning updates from 400ms to 300ms for more responsive feedback
- **Accumulated reasoning**: Instead of just showing individual chunks, accumulate reasoning and extract the most recent sentence for better readability
- **Fallback message**: If data is received but no reasoning, show completion message with token count

### 2. Improved Progress Display
- Reasoning content: Extracts the most recent sentence or clause (split on `.!?`) for cleaner display
- Non-reasoning content: Shows "Received X tokens..." to indicate streaming progress
- Both are limited to 120 characters with ellipsis for readability

## Code Changes

### Modified Functions
1. **Streaming loop** (lines 2975-3070):
   - Added `lastProgressUpdate`, `progressUpdateMs`, `tokensReceived` variables
   - Track tokens when `delta.content` is received
   - Show periodic token count updates when no reasoning content
   - Improved sentence extraction from accumulated reasoning

2. **updateActiveProgressMessage**: Unchanged, already working correctly

3. **emitProgressUpdate**: Unchanged, already working correctly

## Testing Recommendations

1. **With reasoning models** (o1-preview, o1-mini):
   - Verify that reasoning content appears in the sidebar
   - Check that updates appear roughly every 300ms

2. **Without reasoning models** (GPT-4, GPT-3.5):
   - Verify that token count updates appear every second
   - Check that "Received X tokens..." messages display
   - Confirm final "Completed - received X tokens" message appears

3. **General**:
   - Ensure sidebar updates are visible during the entire request
   - Verify progress log shows all stages: "Sending...", streaming updates, "Compiling...", "Validating..."
   - Check that the active progress entry has the spinning animation/styling

## Benefits

1. **Always shows progress**: Users now get feedback regardless of which model they're using
2. **Better transparency**: Token count gives users a sense of how much data is being received
3. **More responsive**: Faster throttling makes the UI feel more live
4. **Cleaner reasoning display**: Extracting sentences provides more readable updates
