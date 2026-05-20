import { RealtimeUtils } from './utils.js';

/**
 * Contains text and audio information about a item
 * Can also be used as a delta
 * @typedef {Object} ItemContentDeltaType
 * @property {string} [text]
 * @property {Int16Array} [audio]
 * @property {string} [arguments]
 * @property {string} [transcript]
 */

/**
 * RealtimeConversation holds conversation history
 * and performs event validation for RealtimeAPI
 * @class
 */
export class RealtimeConversation {
  defaultFrequency = 24_000; // 24,000 Hz

  /**
   * Adds an item once and keeps conversation order stable using previous_item_id links.
   * @param {import('./client.js').ItemType} item
   */
  _registerItem(item) {
    if (!item?.id) {
      return;
    }
    if (!this.itemLookup[item.id]) {
      this.itemLookup[item.id] = item;
      this.items.push(item);
    }
    this._sortItemsByChain();
  }

  /**
   * Reorders items so each item appears after its previous_item_id when present.
   * Falls back to existing order for items without known predecessors.
   */
  _sortItemsByChain() {
    if (!this.items.length) {
      return;
    }
    const inOrder = this.items.slice();
    const seen = new Set();
    const result = [];

    const visit = (item, stack = new Set()) => {
      if (!item?.id || seen.has(item.id)) {
        return;
      }
      if (stack.has(item.id)) {
        // Defensive against malformed cycles from upstream data.
        seen.add(item.id);
        result.push(item);
        return;
      }
      stack.add(item.id);
      const prevId = item.previous_item_id;
      if (prevId && this.itemLookup[prevId] && !seen.has(prevId)) {
        visit(this.itemLookup[prevId], stack);
      }
      stack.delete(item.id);
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    };

    for (const item of inOrder) {
      visit(item);
    }
    this.items = result;
  }

  /**
   * Finds a provisional item (from response.output_item.added) for the same turn.
   * @param {import('./client.js').ItemType} incomingItem
   * @returns {import('./client.js').ItemType | null}
   */
  _findProvisionalMatch(incomingItem) {
    for (const item of this.items) {
      if (!item?.__provisional) continue;
      if (item.type !== incomingItem.type) continue;
      if (item.role !== incomingItem.role) continue;
      if (item.previous_item_id !== incomingItem.previous_item_id) continue;
      return item;
    }
    return null;
  }

  EventProcessors = {
    'conversation.item.created': (event) => {
      const { item } = event;
      // deep copy values
      let newItem = JSON.parse(JSON.stringify(item));
      const existingItem = this.itemLookup[newItem.id];
      if (existingItem) {
        const existingFormatted = existingItem.formatted || {};
        Object.assign(existingItem, newItem);
        existingItem.formatted = existingFormatted;
        newItem = existingItem;
        this._sortItemsByChain();
      } else {
        const provisionalMatch = this._findProvisionalMatch(newItem);
        if (provisionalMatch) {
          const oldId = provisionalMatch.id;
          const existingFormatted = provisionalMatch.formatted || {};
          const existingContent = provisionalMatch.content || [];
          Object.assign(provisionalMatch, newItem);
          provisionalMatch.formatted = existingFormatted;
          if (
            (!provisionalMatch.content || !provisionalMatch.content.length) &&
            existingContent.length
          ) {
            provisionalMatch.content = existingContent;
          }
          provisionalMatch.__provisional = false;
          if (oldId !== provisionalMatch.id) {
            delete this.itemLookup[oldId];
            this.itemLookup[provisionalMatch.id] = provisionalMatch;
          }
          newItem = provisionalMatch;
          this._sortItemsByChain();
        } else {
          this._registerItem(newItem);
        }
      }
      newItem.formatted = newItem.formatted || {};
      newItem.formatted.audio = newItem.formatted.audio || new Int16Array(0);
      newItem.formatted.text = newItem.formatted.text || '';
      newItem.formatted.transcript = newItem.formatted.transcript || '';
      // If we have a speech item, can populate audio
      if (this.queuedSpeechItems[newItem.id]) {
        newItem.formatted.audio = this.queuedSpeechItems[newItem.id].audio;
        delete this.queuedSpeechItems[newItem.id]; // free up some memory
      }
      // Populate formatted text if it comes out on creation
      if (newItem.content) {
        const textContent = newItem.content.filter((c) =>
          ['text', 'input_text'].includes(c.type),
        );
        for (const content of textContent) {
          newItem.formatted.text += content.text;
        }
      }
      // If we have a transcript item, can pre-populate transcript
      if (this.queuedTranscriptItems[newItem.id]) {
        newItem.formatted.transcript = this.queuedTranscriptItems[newItem.id].transcript;
        delete this.queuedTranscriptItems[newItem.id];
      }
      if (newItem.type === 'message') {
        if (newItem.role === 'user') {
          newItem.status = 'completed';
          if (this.queuedInputAudio) {
            newItem.formatted.audio = this.queuedInputAudio;
            this.queuedInputAudio = null;
          }
        } else {
          newItem.status = 'in_progress';
        }
      } else if (newItem.type === 'function_call') {
        newItem.formatted.tool = {
          type: 'function',
          name: newItem.name,
          call_id: newItem.call_id,
          arguments: '',
        };
        newItem.status = 'in_progress';
      } else if (newItem.type === 'function_call_output') {
        newItem.status = 'completed';
        newItem.formatted.output = newItem.output;
      }
      return { item: newItem, delta: null };
    },
    'conversation.item.truncated': (event) => {
      const { item_id, audio_end_ms } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        throw new Error(`item.truncated: Item "${item_id}" not found`);
      }
      // Product decision: when assistant output is interrupted, do not forward
      // the partial assistant turn to downstream upload APIs.
      item.formatted.audio = new Int16Array(0);
      item.formatted.transcript = '';
      item.formatted.text = '';
      item.__interrupted = true;
      return { item, delta: null };
    },
    'conversation.item.deleted': (event) => {
      const { item_id } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        throw new Error(`item.deleted: Item "${item_id}" not found`);
      }
      delete this.itemLookup[item.id];
      const index = this.items.indexOf(item);
      if (index > -1) {
        this.items.splice(index, 1);
      }
      return { item, delta: null };
    },
    'conversation.item.input_audio_transcription.completed': (event) => {
      const { item_id, content_index, transcript } = event;
      const item = this.itemLookup[item_id];
      // We use a single space to represent an empty transcript for .formatted values
      // Otherwise it looks like no transcript provided
      const formattedTranscript = transcript || ' ';
      if (!item) {
        // GA can provide transcription before conversation.item.created.
        // Build a synthetic user item so downstream consumers keep sequence stable.
        const syntheticItem = {
          id: item_id,
          object: 'realtime.item',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [{ type: 'input_audio', transcript: transcript || '' }],
          formatted: {
            audio: new Int16Array(0),
            text: '',
            transcript: formattedTranscript,
          },
        };
        if (this.queuedSpeechItems[item_id]?.audio) {
          syntheticItem.formatted.audio = this.queuedSpeechItems[item_id].audio;
          delete this.queuedSpeechItems[item_id];
        }
        this._registerItem(syntheticItem);
        return { item: syntheticItem, delta: { transcript } };
      } else {
        if (item.content && item.content[content_index]) {
          item.content[content_index].transcript = transcript;
        }
        item.formatted.transcript = formattedTranscript;
        return { item, delta: { transcript } };
      }
    },
    // GA API: streaming transcription deltas
    'conversation.item.input_audio_transcription.delta': (event) => {
      const { item_id, content_index, delta } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        return { item: null, delta: null };
      }
      if (item.content && item.content[content_index]) {
        item.content[content_index].transcript = (item.content[content_index].transcript || '') + delta;
      }
      item.formatted.transcript = (item.formatted.transcript || '') + delta;
      return { item, delta: { transcript: delta } };
    },
    'input_audio_buffer.speech_started': (event) => {
      const { item_id, audio_start_ms } = event;
      this.queuedSpeechItems[item_id] = { audio_start_ms };
      return { item: null, delta: null };
    },
    'input_audio_buffer.speech_stopped': (event, inputAudioBuffer) => {
      const { item_id, audio_end_ms } = event;
      if (!this.queuedSpeechItems[item_id]) {
        this.queuedSpeechItems[item_id] = { audio_start_ms: audio_end_ms };
      }
      const speech = this.queuedSpeechItems[item_id];
      speech.audio_end_ms = audio_end_ms;
      if (inputAudioBuffer) {
        const startIndex = Math.floor(
          (speech.audio_start_ms * this.defaultFrequency) / 1000,
        );
        const endIndex = Math.floor(
          (speech.audio_end_ms * this.defaultFrequency) / 1000,
        );
        speech.audio = inputAudioBuffer.slice(startIndex, endIndex);
        // GA API fix: if item was already created before speech_stopped,
        // retroactively populate formatted.audio on the existing item
        const existingItem = this.itemLookup[item_id];
        if (existingItem && existingItem.formatted) {
          existingItem.formatted.audio = speech.audio;
          return { item: existingItem, delta: null };
        }
      }
      return { item: null, delta: null };
    },
    'response.created': (event) => {
      const { response } = event;
      if (!this.responseLookup[response.id]) {
        this.responseLookup[response.id] = response;
        this.responses.push(response);
      }
      return { item: null, delta: null };
    },
    'response.output_item.added': (event) => {
      const { response_id, item } = event;
      const response = this.responseLookup[response_id];
      if (!response) {
        throw new Error(
          `response.output_item.added: Response "${response_id}" not found`,
        );
      }
      response.output.push(item.id);
      // GA API: pre-register the item so subsequent delta events can find it
      if (item && item.id && !this.itemLookup[item.id]) {
        const newItem = JSON.parse(JSON.stringify(item));
        newItem.formatted = {};
        newItem.formatted.audio = new Int16Array(0);
        newItem.formatted.text = '';
        newItem.formatted.transcript = '';
        if (newItem.type === 'function_call') {
          newItem.formatted.tool = {
            type: 'function',
            name: newItem.name,
            call_id: newItem.call_id,
            arguments: '',
          };
          newItem.status = 'in_progress';
        } else if (newItem.type === 'message') {
          newItem.status = newItem.role === 'user' ? 'completed' : 'in_progress';
        }
        if (!newItem.content) {
          newItem.content = [];
        }
        if (!newItem.arguments) {
          newItem.arguments = '';
        }
        newItem.__provisional = true;
        this._registerItem(newItem);
      }
      return { item: null, delta: null };
    },
    'response.output_item.done': (event) => {
      const { item } = event;
      if (!item) {
        throw new Error(`response.output_item.done: Missing "item"`);
      }
      const foundItem = this.itemLookup[item.id];
      if (!foundItem) {
        // GA API: item may not have been created yet, skip gracefully
        console.warn(
          `response.output_item.done: Item "${item.id}" not found, skipping`,
        );
        return { item: null, delta: null };
      }
      foundItem.status = item.status;
      return { item: foundItem, delta: null };
    },
    'response.content_part.added': (event) => {
      const { item_id, part } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        // GA API: item may not have been created yet, skip gracefully
        console.warn(
          `response.content_part.added: Item "${item_id}" not found, skipping`,
        );
        return { item: null, delta: null };
      }
      item.content.push(part);
      return { item, delta: null };
    },
    'response.output_audio_transcript.delta': (event) => {
      const { item_id, content_index, delta } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        console.warn(
          `response.output_audio_transcript.delta: Item "${item_id}" not found, skipping`,
        );
        return { item: null, delta: null };
      }
      if (item.content[content_index]) {
        item.content[content_index].transcript += delta;
      }
      item.formatted.transcript += delta;
      return { item, delta: { transcript: delta } };
    },
    'response.output_audio.delta': (event) => {
      const { item_id, content_index, delta } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        console.warn(`response.output_audio.delta: Item "${item_id}" not found, skipping`);
        return { item: null, delta: null };
      }
      // This never gets renderered, we care about the file data instead
      // item.content[content_index].audio += delta;
      const arrayBuffer = RealtimeUtils.base64ToArrayBuffer(delta);
      const appendValues = new Int16Array(arrayBuffer);
      item.formatted.audio = RealtimeUtils.mergeInt16Arrays(
        item.formatted.audio,
        appendValues,
      );
      return { item, delta: { audio: appendValues } };
    },
    'response.output_text.delta': (event) => {
      const { item_id, content_index, delta } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        console.warn(`response.output_text.delta: Item "${item_id}" not found, skipping`);
        return { item: null, delta: null };
      }
      if (item.content[content_index]) {
        item.content[content_index].text += delta;
      }
      item.formatted.text += delta;
      return { item, delta: { text: delta } };
    },
    'response.function_call_arguments.delta': (event) => {
      const { item_id, delta } = event;
      const item = this.itemLookup[item_id];
      if (!item) {
        console.warn(
          `response.function_call_arguments.delta: Item "${item_id}" not found, skipping`,
        );
        return { item: null, delta: null };
      }
      item.arguments += delta;
      if (item.formatted.tool) {
        item.formatted.tool.arguments += delta;
      }
      return { item, delta: { arguments: delta } };
    },
  };

  /**
   * Create a new RealtimeConversation instance
   * @returns {RealtimeConversation}
   */
  constructor() {
    this.clear();
  }

  /**
   * Clears the conversation history and resets to default
   * @returns {true}
   */
  clear() {
    this.itemLookup = {};
    this.items = [];
    this.responseLookup = {};
    this.responses = [];
    this.queuedSpeechItems = {};
    this.queuedTranscriptItems = {};
    this.queuedInputAudio = null;
    return true;
  }

  /**
   * Queue input audio for manual speech event
   * @param {Int16Array} inputAudio
   * @returns {Int16Array}
   */
  queueInputAudio(inputAudio) {
    this.queuedInputAudio = inputAudio;
    return inputAudio;
  }

  /**
   * Process an event from the WebSocket server and compose items
   * @param {Object} event
   * @param  {...any} args
   * @returns {item: import('./client.js').ItemType | null, delta: ItemContentDeltaType | null}
   */
  processEvent(event, ...args) {
    if (!event.event_id) {
      console.error(event);
      throw new Error(`Missing "event_id" on event`);
    }
    if (!event.type) {
      console.error(event);
      throw new Error(`Missing "type" on event`);
    }
    const eventProcessor = this.EventProcessors[event.type];
    if (!eventProcessor) {
      // GA API may send new event types we don't have processors for
      console.warn(
        `Missing conversation event processor for "${event.type}", skipping`,
      );
      return { item: null, delta: null };
    }
    return eventProcessor.call(this, event, ...args);
  }

  /**
   * Retrieves a item by id
   * @param {string} id
   * @returns {import('./client.js').ItemType}
   */
  getItem(id) {
    return this.itemLookup[id] || null;
  }

  /**
   * Retrieves all items in the conversation
   * @returns {import('./client.js').ItemType[]}
   */
  getItems() {
    return this.items.slice();
  }
}
