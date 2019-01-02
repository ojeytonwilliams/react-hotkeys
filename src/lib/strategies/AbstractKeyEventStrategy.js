import KeyEventBitmapManager from '../KeyEventBitmapManager';
import KeyEventBitmapIndex from '../../const/KeyEventBitmapIndex';
import Logger from '../Logger';
import KeyCombinationSerializer from '../KeyCombinationSerializer';
import arrayFrom from '../../utils/array/arrayFrom';
import indexFromEnd from '../../utils/array/indexFromEnd';
import isObject from '../../utils/object/isObject';
import isUndefined from '../../utils/isUndefined';
import isEmpty from '../../utils/collection/isEmpty';
import resolveAltShiftedAlias from '../../helpers/resolving-handlers/resolveAltShiftedAlias';
import resolveShiftedAlias from '../../helpers/resolving-handlers/resolveShiftedAlias';
import resolveAltedAlias from '../../helpers/resolving-handlers/resolveAltedAlias';
import resolveKeyAlias from '../../helpers/resolving-handlers/resolveKeyAlias';
import KeyEventSequenceIndex from '../../const/KeyEventSequenceIndex';
import KeySequenceParser from '../KeySequenceParser';

/**
 * @typedef {String} KeyName Name of the keyboard key
 */

/**
 * @typedef {Number} ComponentIndex Unique index associated with every HotKeys component
 * as it becomes active.
 *
 * For focus-only components, this happens when the component is focused. The HotKeys
 * component closest to the DOM element in focus gets the smallest number (0) and
 * those further up the render tree get larger (incrementing) numbers. When a different
 * element is focused (triggering the creation of a new focus tree) all component indexes
 * are reset (de-allocated) and re-assigned to the new tree of HotKeys components that
 * are now in focus.
 *
 * For global components, component indexes are assigned when a HotKeys component is
 * mounted, and de-allocated when it unmounts. The component index counter is never reset
 * back to 0 and just keeps incrementing as new components are mounted.
 */

/**
 * @typedef {Object} KeyCombinationObject Object containing description of a key
 *          combination to compared against key events
 * @extends BasicKeyCombination
 * @property {ComponentIndex} componentIndex Id associated with the HotKeys component
 *          that registered the key sequence
 * @property {Number} size Number of key combinations in the key sequence
 * @property {KeyEventBitmapIndex} eventBitmapIndex Index that matches key event type
 * @property {ActionName} actionName Name of the action that should be triggered if a
 *           keyboard event matching the combination and event type occur
 */

/**
 * @typedef {Object} KeyEventMatcher Object containing key sequence and combination
 *          descriptions for a particular HotKeys component
 * @property {KeySequenceObject} sequences Map of key sequences
 * @property {KeyCombinationObject} combinations Map of key combinations
 * @property {KeyCombinationString[]} combinationsOrder Order of combinations from highest
 *            priority to lowest
 */

class AbstractKeyEventStrategy {
  static _describeKeyEvent(eventBitmapIndex) {
    switch(parseInt(eventBitmapIndex, 10)) {
      case 0: return 'keydown';
      case 1: return 'keypress';
      default: return 'keyup';
    }
  }

  static logIcons = ['📕', '📗', '📘', '📙'];
  static componentIcons = ['🔺', '⭐️', '🔷', '🔶', '⬛️'];
  static eventIcons = ['❤️', '💚', '💙', '💛', '💜', '🧡'];

  constructor(configuration = {}) {
    this.logger = configuration.logger || new Logger('warn');

    this.componentIndex = 0;

    this._reset();
  }

  _reset() {
    this._resetRegisteredKeyMapsState();
    this._resetHandlerResolutionState();
    this._resetKeyCombinationState();
  }

  _resetRegisteredKeyMapsState() {
    /**
     * This state is maintained by the _buildKeyMatcherMap() method
     */

    /**
     * @typedef {Object} ComponentOptions Object containing a description of the key map
     *          and handlers from a particular HotKeys component
     * @property {KeyEventMatcher} keyMatchersMap Map of ActionNames to
     *           KeySequenceDSLStatement
     * @property {EventHandlerMap} handlers Map of ActionNames to EventHandlers
     */

    /**
     * List of actions and handlers registered by each component currently in focus.
     * The component closest to the element in focus is last in the list.
     * @type {ComponentOptions[]}
     */
    this.componentList = [];

    /**
     * Counter for the longest sequence registered by the HotKeys components currently
     * in focus. Allows setting an upper bound on the length of the key event history
     * that must be kept.
     * @type {Number}
     */
    this.longestSequence = 1;

    this.longestSequenceComponentIndex = null;

    /**
     * Bitmap to record whether there is at least one keymap bound to each event type
     * (keydown, keypress or keyup) so that we can skip trying to find a matching keymap
     * on events where we know there is none to find
     * @type {KeyEventBitmap}
     */
    this.keyMapEventBitmap = KeyEventBitmapManager.newBitmap();
  }

  _resetHandlerResolutionState() {
    /**
     * List of mappings from key sequences to handlers that is constructed on-the-fly
     * as key events propagate up the render tree
     */
    this.keyMaps = null;

    /**
     * Index marking the number of places from the end of componentList for which the
     * keyMaps have been matched with event handlers. Used to build this.keyMaps as
     * key events propagate up the React tree.
     * @type {Number}
     */
    this.searchIndex =  0;

    /**
     * Array of counters - one for each component - to keep track of how many handlers
     * for that component still need actions assigned to them
     * @type {Number[]}
     */
    this.unmatchedHandlerStatus = null;

    /**
     * A dictionary of handlers to the components that register them. This is populated
     * as this.searchIndex increases, moving from the end of this.componentList to the
     * front, populating this.keyMaps as needed
     * @type {Object<ActionName, ComponentIndex>}
     */
    this.handlersDictionary = {};

    /**
     * A dictionary of sequences already encountered in the process of building the
     * list of keyMaps on the fly, as key events propagate up the component tree
     */
    this.keySequencesDictionary = {};
  }

  _resetKeyCombinationState() {
    /**
     * Whether the current key combination includes at least one keyup event - indicating
     * that the current combination is ending (and keys are being released)
     */
    this.keyCombinationIncludesKeyUp = false;

    this.keypressEventsToSimulate = [];

    /**
     * @typedef {Object.<String, KeyEventBitmap[]>} KeyCombinationRecord A dictionary of keys that
     * have been pressed down at once. The keys of the map are the lowercase names of the
     * keyboard keys. May contain 1 or more keyboard keys.
     *
     * @example: A key combination for when shift and A have been pressed, but not released:
     *
     * {
     *   shift: [ [true,false,false], [true,true,false] ],
     *   A: [ [true,true,false], [true,true,false] ]
     * }
     *
     * List of most recent key combinations seen by the KeyEventManager
     * @type {KeyCombinationRecord[]}
     */
    if (!this.keyCombinationHistory || this.keyCombinationHistory.length < 1) {
      this.keyCombinationHistory = [];
    } else {
      const currentKeyCombination = this._getCurrentKeyCombination();

      const keysStillPressed = Object.keys(currentKeyCombination.keys).reduce((memo, keyName) => {
        const keyState = currentKeyCombination.keys[keyName];
        const currentKeyState = keyState[KeyEventSequenceIndex.current];

        if (currentKeyState[KeyEventBitmapIndex.keydown] && !currentKeyState[KeyEventBitmapIndex.keyup]) {
          memo[keyName] = keyState;
        }

        return memo;
      }, {});

      this.keyCombinationHistory = [
        {
          keys: keysStillPressed,
          ids: KeyCombinationSerializer.serialize(keysStillPressed)
        }
      ]
    }
  }

  _addComponentToList(componentIndex, actionNameToKeyMap = {}, actionNameToHandlersMap = {}, options) {
    const componentOptions = this._buildComponentOptions(
      componentIndex,
      actionNameToKeyMap,
      actionNameToHandlersMap,
      options
    );

    this.componentList.push(componentOptions);
  }

  /**
   * Returns the current key combination, i.e. the key combination that represents
   * the current key events.
   * @returns {KeyCombinationRecord} The current key combination
   * @private
   */
  _getCurrentKeyCombination() {
    if (this.keyCombinationHistory.length > 0) {
      return this.keyCombinationHistory[this.keyCombinationHistory.length - 1];
    } else {
      return { keys: {}, ids: [ '' ] };
    }
  }

  /**
   * Adds a key event to the current key combination (as opposed to starting a new
   * keyboard combination).
   * @param {String} keyName Name of the key to add to the current combination
   * @param {KeyEventBitmapIndex} bitmapIndex Index in bitmap to set to true
   * @private
   */
  _addToCurrentKeyCombination(keyName, bitmapIndex) {
    if (this.keyCombinationHistory.length === 0) {
      this.keyCombinationHistory.push({ keys: {}, ids: [ '' ] });
    }

    const keyCombination = this._getCurrentKeyCombination();

    const existingBitmap = keyCombination.keys[keyName];

    if (!existingBitmap) {
      keyCombination.keys[keyName] = [
        KeyEventBitmapManager.newBitmap(),
        KeyEventBitmapManager.newBitmap(bitmapIndex)
      ];

    } else {
      keyCombination.keys[keyName] = [
        KeyEventBitmapManager.clone(existingBitmap[1]),
        KeyEventBitmapManager.newBitmap(bitmapIndex)
      ];
    }

    keyCombination.ids = KeyCombinationSerializer.serialize(keyCombination.keys);
  }

  /**
   * Adds a new KeyCombinationRecord to the event history and resets the keystateIncludesKeyUp
   * flag to false.
   * @param {String} keyName Name of the keyboard key to add to the new KeyCombinationRecord
   * @param {KeyEventBitmapIndex} eventBitmapIndex Index of bit to set to true in new
   *        KeyEventBitmap
   * @private
   */
  _startNewKeyCombination(keyName, eventBitmapIndex) {
    if (this.keyCombinationHistory.length > this.longestSequence) {
      /**
       * We know the longest key sequence registered for the currently focused
       * components, so we don't need to keep a record of history longer than
       * that
       */
      this.keyCombinationHistory.shift();
    }

    const lastKeyCombination = this._getCurrentKeyCombination();

    const keys = {
      ...this._withoutKeyUps(lastKeyCombination),
      [keyName]: [
        KeyEventBitmapManager.newBitmap(),
        KeyEventBitmapManager.newBitmap(eventBitmapIndex)
      ]
    };

    this.keyCombinationHistory.push({
      keys,
      ids: KeyCombinationSerializer.serialize(keys)
    });

    this.keyCombinationIncludesKeyUp = false;
  }

  /**
   * Returns a new KeyCombinationRecord without the keys that have been
   * released (had the keyup event recorded). Essentially, the keys that are
   * currently still pressed down at the time a key event is being handled.
   * @param {KeyCombinationRecord} keyCombinationRecord Record of keys currently
   *        pressed down that should have the release keyed omitted from
   * @returns {KeyCombinationRecord} New KeyCombinationRecord with all of the
   *        keys with keyup events omitted
   * @private
   */
  _withoutKeyUps(keyCombinationRecord) {
    return Object.keys(keyCombinationRecord.keys).reduce((memo, keyName) => {
      const keyState = keyCombinationRecord.keys[keyName];

      if (!keyState[KeyEventSequenceIndex.current][KeyEventBitmapIndex.keyup]) {
        memo[keyName] = keyState;
      }

      return memo;
    }, {});
  }

  _callMatchingHandlerClosestToEventTarget(event, keyName, eventBitmapIndex, componentIndex) {
    if (!this.keyMaps || !this.unmatchedHandlerStatus) {
      /**
       * Initialize key maps and unmatched handler counts the first time a key event
       * is received by a new focus tree
       */
      this.keyMaps = [];
      this.unmatchedHandlerStatus = [];

      this.componentList.forEach(({ handlers }) => {
        this.unmatchedHandlerStatus.push( [ Object.keys(handlers).length, {} ]);
        this.keyMaps.push({});
      });
    }

    const unmatchedHandlersStatus = this.unmatchedHandlerStatus[componentIndex];
    let unmatchedHandlersCount = unmatchedHandlersStatus[0];

    if (unmatchedHandlersCount > 0) {
      /**
       * Component currently handling key event has handlers that have not yet been
       * associated with a key sequence. We need to continue walking up the component
       * tree in search of the matching actions that describe the applicable key
       * sequence.
       */

      if (this.searchIndex < componentIndex) {
        this.searchIndex = componentIndex;
      }

      while (this.searchIndex < this.componentList.length && unmatchedHandlersCount > 0) {
        const { handlers, actions } = this.componentList[this.searchIndex];

        /**
         * Add current component's handlers to the handlersDictionary so we know
         * what component has defined them
         */
        Object.keys(handlers).forEach((actionName) => {
          if (!this.handlersDictionary[actionName]) {
            this.handlersDictionary[actionName] = [];
          }

          this.handlersDictionary[actionName].push(this.searchIndex);
        });

        /**
         * Iterate over the actions of a component (starting with the current component
         * and working through its ancestors), matching them to the current component's
         * handlers
         */
        Object.keys(actions).forEach((actionName) => {
          const handlerComponentIndexArray = this.handlersDictionary[actionName];

          if (handlerComponentIndexArray) {
            /**
             * Get action handler closest to the event target
             */
            const handlerComponentIndex = handlerComponentIndexArray[0];

            const handler =
              this.componentList[handlerComponentIndex].handlers[actionName];

            /**
             * Get key map that corresponds with the component that defines the handler
             * closest to the event target
             */
            const keyMap = this.keyMaps[handlerComponentIndex];

            /**
             * Store the key sequence with the handler that it should call at
             * a given component level
             */
            if (!keyMap.sequences) {
              keyMap.sequences = {};
            }

            /**
             * At least one child HotKeys component (or the component itself) has
             * defined a handler for the action, so now we need to associate them
             */
            const keyMatchers = actions[actionName];

            keyMatchers.forEach((keyMatcher) => {
              const keySequence = [keyMatcher.prefix, keyMatcher.id].join(' ');

              const closestSequenceHandlerAlreadyFound =
                this.keySequencesDictionary[keySequence] &&
                this.keySequencesDictionary[keySequence].some((dictEntry) => {
                  return dictEntry[1] === keyMatcher.eventBitmapIndex
                });

              if (closestSequenceHandlerAlreadyFound) {
                /**
                 * Return if there is already a component with handlers for the current
                 * key sequence closer to the event target
                 */
                return;
              }

              if (!keyMap.sequences[keyMatcher.prefix]) {
                keyMap.sequences[keyMatcher.prefix] = { combinations: {} };
              }

              const {
                prefix, sequenceLength, id, keyDictionary, size,
                eventBitmapIndex: matcherEventBitmapIndex,
                actionName
              } = keyMatcher;

              const combination =
                keyMap.sequences[keyMatcher.prefix].combinations[keyMatcher.id];

              if (!combination) {
                keyMap.sequences[keyMatcher.prefix].combinations[keyMatcher.id] = {
                  prefix, sequenceLength, id, keyDictionary, size,
                  events: {
                    [matcherEventBitmapIndex]: {
                      actionName, eventBitmapIndex: matcherEventBitmapIndex, handler
                    }
                  }
                };
              } else {
                keyMap.sequences[keyMatcher.prefix].combinations[keyMatcher.id] = {
                  ...combination,
                  events: {
                    ...combination.events,
                    [matcherEventBitmapIndex]: {
                      actionName, eventBitmapIndex: matcherEventBitmapIndex, handler
                    }
                  }
                }
              }

              /**
               * Merge event bitmaps so we can quickly determine if a given component
               * has any handlers bound to particular key events
               */
              if (!keyMap.eventBitmap) {
                keyMap.eventBitmap = KeyEventBitmapManager.newBitmap();
              }

              KeyEventBitmapManager.setBit(keyMap.eventBitmap, keyMatcher.eventBitmapIndex);

              /**
               * Record the longest sequence length so we know to only check for sequences
               * of that length or shorter for a particular component
               */
              if (!keyMap.longestSequence || keyMap.longestSequence < keyMatcher.sequenceLength) {
                keyMap.longestSequence = keyMatcher.sequenceLength;
              }

              /**
               * Record that we have already found a handler for the current action so
               * that we do not override handlers for an action closest to the event target
               * with handlers further up the tree
               */
              if (!this.keySequencesDictionary[keySequence]) {
                this.keySequencesDictionary[keySequence] = [];
              }

              this.keySequencesDictionary[keySequence].push([
                handlerComponentIndex,
                keyMatcher.eventBitmapIndex
              ]);
            });

            handlerComponentIndexArray.forEach((handlerComponentIndex) => {
              const handlerComponentStatus = this.unmatchedHandlerStatus[handlerComponentIndex];

              if (!handlerComponentStatus[1][actionName]) {
                handlerComponentStatus[1][actionName] = true;

                /**
                 * Decrement the number of remaining unmatched handlers for the
                 * component currently handling the propagating key event, so we know
                 * when all handlers have been matched to sequences and we can move on
                 * to matching them against the current key event
                 */
                handlerComponentStatus[0]--;
              }
            });
          }
        });

        /**
         * Search next component up in the hierarchy for actions that match outstanding
         * handlers
         */
        this.searchIndex++;
      }
    }

    const keyMap = this.keyMaps[componentIndex];

    this.logger.verbose(
      `${this._logPrefix(componentIndex)} Internal key mapping:\n`,
      `${this._printComponent(keyMap)}`
    );

    if (!keyMap || isEmpty(keyMap.sequences) || !keyMap.eventBitmap[eventBitmapIndex]) {
      /**
       * Component doesn't define any matchers for the current key event
       */

      this.logger.debug(`${this._logPrefix(componentIndex)} Doesn't define a handler for '${this._describeCurrentKeyCombination()}' ${this.constructor._describeKeyEvent(eventBitmapIndex)}.`);

      return;
    }

    const { sequences, longestSequence } = keyMap;

    const currentKeyState = this._getCurrentKeyCombination();

    let sequenceLengthCounter = longestSequence;

    while(sequenceLengthCounter >= 0) {
      const sequenceHistory = this.keyCombinationHistory.slice(-sequenceLengthCounter, -1);
      const sequenceHistoryIds = sequenceHistory.map(({ ids }) => ids );

      const matchingSequence = this._tryMatchSequenceWithKeyAliases(sequences, sequenceHistoryIds);

      if (matchingSequence) {
        if (!matchingSequence.order) {
          /**
           * The first time the component that is currently handling the key event has
           * its handlers searched for a match, order the combinations based on their
           * size so that they may be applied in the correct priority order
           */

          const combinationsPartitionedBySize = Object.values(matchingSequence.combinations).reduce((memo, { id, size }) => {
            if (!memo[size]) {
              memo[size] = [];
            }

            memo[size].push(id);

            return memo;
          }, {});

          matchingSequence.order = Object.keys(combinationsPartitionedBySize).sort((a, b) => b-a ).reduce((memo, key) => {
            return memo.concat(combinationsPartitionedBySize[key]);
          }, []);
        }

        const combinationOrder = matchingSequence.order;

        let combinationIndex = 0;

        while(combinationIndex < combinationOrder.length) {
          const combinationId = combinationOrder[combinationIndex];
          const combinationMatcher = matchingSequence.combinations[combinationId];

          if (this._combinationMatchesKeys(keyName, currentKeyState, combinationMatcher, eventBitmapIndex)) {
            this.logger.debug(`${this._logPrefix(componentIndex)} Found action that matches '${this._describeCurrentKeyCombination()}': ${combinationMatcher.events[eventBitmapIndex].actionName}. Calling handler . . .`);
            combinationMatcher.events[eventBitmapIndex].handler(event);

            return true;
          }

          combinationIndex++;
        }

      }

      sequenceLengthCounter--;
    }

    const eventName = this.constructor._describeKeyEvent(eventBitmapIndex);
    this.logger.debug(`${this._logPrefix(componentIndex)} No matching actions found for '${this._describeCurrentKeyCombination()}' ${eventName}.`);
  }

  _describeCurrentKeyCombination() {
    return this._getCurrentKeyCombination().ids[0];
  }

  _tryMatchSequenceWithKeyAliases(keyMatcher, sequenceIds) {
    if (sequenceIds.length === 0) {
      return keyMatcher[''];
    }

    const idSizes = sequenceIds.map((ids) => ids.length);
    const indexCounters = sequenceIds.map(() => 0);

    let triedAllPossiblePermutations = false;

    while (!triedAllPossiblePermutations) {
      const sequenceIdPermutation = indexCounters.map((sequenceIdIndex, index) => {
        return sequenceIds[index][sequenceIdIndex];
      });

      const candidateId = sequenceIdPermutation.join(' ');

      if (keyMatcher[candidateId]) {
        return keyMatcher[candidateId];
      }

      let incrementer = 0;
      let carry = true;

      while (carry && incrementer < indexCounters.length) {
        const count = indexFromEnd(indexCounters, incrementer);

        const newIndex = (count + 1) % (indexFromEnd(idSizes, incrementer) || 1);

        indexCounters[indexCounters.length - (incrementer + 1)] = newIndex;

        carry = newIndex === 0;

        if (carry) {
          incrementer++;
        }
      }

      triedAllPossiblePermutations = incrementer === indexCounters.length;
    }
  }

  _combinationMatchesKeys(keyBeingPressed, keyboardState, combinationMatch, eventBitmapIndex) {
    const combinationHasHandlerForEventType =
      combinationMatch.events[eventBitmapIndex];

    if (!combinationHasHandlerForEventType) {
      return false;
    }

    let keyCompletesCombination = false;

    const combinationMatchesKeysPressed = !Object.keys(combinationMatch.keyDictionary).some((candidateKeyName) => {
      const keyInKeyboardState =
        this._keyNameAsItAppearsInKeyboardState(candidateKeyName);

      if (keyInKeyboardState) {
        const keyState = keyboardState.keys[keyInKeyboardState];

        if (this._keyIsCurrentlyTriggeringEvent(keyState, eventBitmapIndex)) {
          if (keyBeingPressed && keyInKeyboardState === keyBeingPressed) {
            keyCompletesCombination =
              !this._keyAlreadyTriggeredEvent(keyState, eventBitmapIndex);
          }

          return false;
        } else {
          return true;
        }
      } else {
        return true;
      }
    });

    return combinationMatchesKeysPressed && keyCompletesCombination;
  }

  _keyIsCurrentlyTriggeringEvent(keyState, eventBitmapIndex) {
    return keyState[KeyEventSequenceIndex.current][eventBitmapIndex];
  }

  _keyAlreadyTriggeredEvent(keyState, eventBitmapIndex) {
    return keyState[KeyEventSequenceIndex.previous][eventBitmapIndex];
  }

  _keyNameAsItAppearsInKeyboardState(keyName) {
    const keyboardState = this._getCurrentKeyCombination();

    if (keyboardState.keys[keyName]) {
      return keyName;
    } else {
      return this._tryMatchWithKeyAliases(keyboardState, keyName);
    }
  }

  _tryMatchWithKeyAliases(keyState, candidateKeyName) {
    const candidateKeyNames = function(){
      const combinationIncludesShift = keyState.keys['Shift'];
      const combinationIncludesAlt = keyState.keys['Alt'];

      if (combinationIncludesShift) {
        if (combinationIncludesAlt) {
          return resolveAltShiftedAlias(candidateKeyName);
        } else {
          return resolveShiftedAlias(candidateKeyName);
        }
      } else {
        if (combinationIncludesAlt) {
          return resolveAltedAlias(candidateKeyName);
        } else {
          return resolveKeyAlias(candidateKeyName);
        }
      }
    }();

    return candidateKeyNames.find((keyName) => keyState.keys[keyName]);
  }

  _buildComponentOptions(componentIndex, actionNameToKeyMap, actionNameToHandlersMap, options) {
    const { keyMap: hardSequenceKeyMap, handlers } =
      this._applyHardSequences(actionNameToKeyMap, actionNameToHandlersMap);

    return {
      actions: this._buildKeyMatcherMap(
        {
          ...actionNameToKeyMap,
          ...hardSequenceKeyMap
        },
        options,
        componentIndex
      ),
      handlers,
      componentIndex,
      options
    };
  }

  _applyHardSequences(actionNameToKeyMap, actionNameToHandlersMap) {
    return Object.keys(actionNameToHandlersMap).reduce((memo, actionNameOrKeyExpression) => {
      const actionNameIsInKeyMap = !!actionNameToKeyMap[actionNameOrKeyExpression];

      const handler = actionNameToHandlersMap[actionNameOrKeyExpression];

      if (!actionNameIsInKeyMap && KeyCombinationSerializer.isValidKeySerialization(actionNameOrKeyExpression)) {
        memo.keyMap[actionNameOrKeyExpression] = actionNameOrKeyExpression;
      }

      memo.handlers[actionNameOrKeyExpression] = handler;

      return memo;
    }, { keyMap: {}, handlers: {}});
  }

  /**
   * @typedef {Object} KeyExpressionObject Object describing a key event
   * @property {KeySequenceString|KeyCombinationString|KeySequenceString[]|KeyCombinationString[]} sequence
   * @property {EventType} action
   */

  /**
   * Converts a ActionKeyMap to a KeyExpressionObject and saves it so it can later be
   * recalled and matched against key events
   * @param {ActionKeyMap} actionNameToKeyMap Mapping of ActionNames to key sequences
   * @param {Object<String, any>} options Hash of options that configure how the key
   *        map is built.
   * @param {String} options.defaultKeyEvent The default key event to use for any action
   *        that does not explicitly define one.
   * @param {ComponentIndex} componentIndex Index of the component the matcher belongs to
   * @return {KeyEventMatcher}
   * @private
   */
  _buildKeyMatcherMap(actionNameToKeyMap, options, componentIndex) {
    return Object.keys(actionNameToKeyMap).reduce((keyMapMemo, actionName) => {
      const keyMapOptions = arrayFrom(actionNameToKeyMap[actionName]);

      keyMapOptions.forEach((keyMapOption) => {
        const { keySequence, eventBitmapIndex } = function(){
          if (isObject(keyMapOption)) {
            const { sequence, action } = keyMapOption;

            return {
              keySequence: sequence,
              eventBitmapIndex: isUndefined(action) ? KeyEventBitmapIndex[options.defaultKeyEvent] : KeyEventBitmapIndex[action]
            };
          } else {
            return {
              keySequence: keyMapOption,
              eventBitmapIndex: KeyEventBitmapIndex[options.defaultKeyEvent]
            }
          }
        }();

        const { sequence, combination } = KeySequenceParser.parse(keySequence, { eventBitmapIndex });

        if (sequence.size > this.longestSequence) {
          this.longestSequence = sequence.size;
          this.longestSequenceComponentIndex = componentIndex;
        }

        /**
         * Record that there is at least one key sequence in the focus tree bound to
         * the keyboard event
         */
        KeyEventBitmapManager.setBit(this.keyMapEventBitmap, eventBitmapIndex);

        if (!keyMapMemo[actionName]) {
          keyMapMemo[actionName] = [];
        }

        keyMapMemo[actionName].push({
          prefix: sequence.prefix,
          actionName,
          sequenceLength: sequence.size,
          ...combination,
        });
      });

      return keyMapMemo;
    }, {});
  }

  _printComponent(component) {
    return JSON.stringify(
      component,
      this._componentAttributeSerializer,
      4
    )
  }

  _componentAttributeSerializer(key, value) {
    if (typeof value === 'function') {
      return value.toString();
    }

    return value;
  };
}

export default AbstractKeyEventStrategy;