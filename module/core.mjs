import { PatchError, _deepClone, isInteger, unescapePathComponent, hasUndefined, PROTO_ERROR_MSG, isValidExtendedOpId, _graftTree } from './helpers.mjs';
export var JsonPatchError = PatchError;
export var deepClone = _deepClone;
;
/* Registry of Extended operations */
var xOpRegistry = new Map();
/* We use a Javascript hash to store each
 function. Each hash entry (property) uses
 the operation identifiers specified in rfc6902.
 In this way, we can map each patch operation
 to its dedicated function in efficient way.
 */
/* The operations applicable to an object */
var objOps = {
    add: function (obj, key, document) {
        obj[key] = this.value;
        return { newDocument: document };
    },
    remove: function (obj, key, document) {
        var removed = obj[key];
        delete obj[key];
        return { newDocument: document, removed: removed };
    },
    replace: function (obj, key, document) {
        var removed = obj[key];
        obj[key] = this.value;
        return { newDocument: document, removed: removed };
    },
    move: function (obj, key, document) {
        /* in case move target overwrites an existing value,
        return the removed value, this can be taxing performance-wise,
        and is potentially unneeded */
        var removed = getValueByPointer(document, this.path);
        if (removed) {
            removed = _deepClone(removed);
        }
        var originalValue = applyOperation(document, { op: "remove", path: this.from }).removed;
        applyOperation(document, { op: "add", path: this.path, value: originalValue });
        return { newDocument: document, removed: removed };
    },
    copy: function (obj, key, document) {
        var valueToCopy = getValueByPointer(document, this.from);
        // enforce copy by value so further operations don't affect source (see issue #177)
        applyOperation(document, { op: "add", path: this.path, value: _deepClone(valueToCopy) });
        return { newDocument: document };
    },
    test: function (obj, key, document) {
        return { newDocument: document, test: _areEquals(obj[key], this.value) };
    },
    _get: function (obj, key, document) {
        this.value = obj[key];
        return { newDocument: document };
    }
};
/* The operations applicable to an array. Many are the same as for the object */
var arrOps = {
    add: function (arr, i, document) {
        if (isInteger(String(i))) {
            arr.splice(~~i, 0, this.value);
        }
        else { // array props
            arr[i] = this.value;
        }
        // this may be needed when using '-' in an array
        return { newDocument: document, index: i };
    },
    remove: function (arr, i, document) {
        var removedList = arr.splice(~~i, 1);
        return { newDocument: document, removed: removedList[0] };
    },
    replace: function (arr, i, document) {
        var removed = arr[i];
        arr[i] = this.value;
        return { newDocument: document, removed: removed };
    },
    move: objOps.move,
    copy: objOps.copy,
    test: objOps.test,
    _get: objOps._get
};
/**
 * Registers an extended (non-RFC 6902) operation for processing.
 * Will overwrite configs that already exist for given xid string
 *
 * @param xid The operation id (must follow the convention /^x-[a-z]+$/
 *  to avoid visual confusion with the RFC's ops)
 * @param config the operation configuration object containing
 *  the array, and object operators (functions), and a validator function for
 *  the extended operation
 */
export function useExtendedOperation(xid, config) {
    if (!isValidExtendedOpId(xid)) {
        throw new JsonPatchError('Extended operation `xid` has malformed id (MUST begin with `x-`)', 'OPERATION_X_ID_INVALID', undefined, xid);
    }
    // basic checks for all props
    if (typeof config.arr !== 'function') {
        throw new JsonPatchError('Extended operation config has invalid `arr` function', 'OPERATION_X_CONFIG_INVALID', undefined, xid);
    }
    if (typeof config.obj !== 'function') {
        throw new JsonPatchError('Extended operation config has invalid `obj` function', 'OPERATION_X_CONFIG_INVALID', undefined, xid);
    }
    if (typeof config.validator !== 'function') {
        throw new JsonPatchError('Extended operation config has invalid `validator` function', 'OPERATION_X_CONFIG_INVALID', undefined, xid);
    }
    // register config as immutable obj
    xOpRegistry.set(xid, Object.freeze(config));
}
/**
 * Performs check for a registered extended (non-RFC 6902) operation.
 *
 * @param xid the qualified ("x-<foo>") extended operation name
 * @return boolean true if xop is registered as an extended operation
 */
export function hasExtendedOperation(xid) {
    if (!isValidExtendedOpId(xid)) {
        throw new JsonPatchError('Extended operation `xid` has malformed id (MUST begin with `x-`)', 'OPERATION_X_ID_INVALID', undefined, xid);
    }
    return xOpRegistry.has(xid);
}
/**
 * Removes all previously registered extended operation configurations.
 * (primarily used during unit testing)
 */
export function unregisterAllExtendedOperations() {
    xOpRegistry.clear();
}
/**
 * Retrieves a value from a JSON document by a JSON pointer.
 * Returns the value.
 *
 * @param document The document to get the value from
 * @param pointer an escaped JSON pointer
 * @return The retrieved value
 */
export function getValueByPointer(document, pointer) {
    if (pointer == '') {
        return document;
    }
    var getOriginalDestination = { op: "_get", path: pointer };
    applyOperation(document, getOriginalDestination);
    return getOriginalDestination.value;
}
/**
 * Apply a single JSON Patch Operation on a JSON document.
 * Returns the {newDocument, result} of the operation.
 * It modifies the `document` and `operation` objects - it gets the values by reference.
 * If you would like to avoid touching your values, clone them:
 * `jsonpatch.applyOperation(document, jsonpatch._deepClone(operation))`.
 *
 * @param document The document to patch
 * @param operation The operation to apply
 * @param validateOperation `false` is without validation, `true` to use default jsonpatch's validation, or you can pass a `validateOperation` callback to be used for validation.
 * @param mutateDocument Whether to mutate the original document or clone it before applying
 * @param banPrototypeModifications Whether to ban modifications to `__proto__`, defaults to `true`.
 * @return `{newDocument, result}` after the operation
 */
export function applyOperation(document, operation, validateOperation, mutateDocument, banPrototypeModifications, index) {
    if (validateOperation === void 0) { validateOperation = false; }
    if (mutateDocument === void 0) { mutateDocument = true; }
    if (banPrototypeModifications === void 0) { banPrototypeModifications = true; }
    if (index === void 0) { index = 0; }
    if (validateOperation) {
        if (typeof validateOperation == 'function') {
            validateOperation(operation, 0, document, operation.path);
        }
        else {
            validator(operation, 0);
        }
    }
    /* ROOT OPERATIONS */
    if (operation.path === "") {
        var returnValue = { newDocument: document };
        if (operation.op === 'add') {
            returnValue.newDocument = operation.value;
            return returnValue;
        }
        else if (operation.op === 'replace') {
            returnValue.newDocument = operation.value;
            returnValue.removed = document; //document we removed
            return returnValue;
        }
        else if (operation.op === 'move' || operation.op === 'copy') { // it's a move or copy to root
            returnValue.newDocument = getValueByPointer(document, operation.from); // get the value by json-pointer in `from` field
            if (operation.op === 'move') { // report removed item
                returnValue.removed = document;
            }
            return returnValue;
        }
        else if (operation.op === 'test') {
            returnValue.test = _areEquals(document, operation.value);
            if (returnValue.test === false) {
                throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', index, operation, document);
            }
            returnValue.newDocument = document;
            return returnValue;
        }
        else if (operation.op === 'remove') { // a remove on root
            returnValue.removed = document;
            returnValue.newDocument = null;
            return returnValue;
        }
        else if (operation.op === '_get') {
            operation.value = document;
            return returnValue;
        }
        else if (operation.op === 'x') {
            // get extended config
            var xConfig = xOpRegistry.get(operation.xid);
            if (!xConfig) {
                throw new JsonPatchError('Extended operation `xid` property is not a registered extended operation', 'OPERATION_X_OP_INVALID', index, operation, document);
            }
            // at empty (root) path default to obj operator
            var workingDocument = document;
            var obj = document;
            if (!mutateDocument) {
                obj = workingDocument = _deepClone(document);
            }
            var result = { newDocument: operation.value };
            // if resolve is true, allow extended operator to run against supplied
            // document object/clone
            if (operation.resolve === true) {
                result = xConfig.obj.call(operation, obj, '', workingDocument);
                // in resolve mode, allow operator result of undefined to revert back to
                // original document
                if (result === undefined) {
                    return { newDocument: document };
                }
            }
            return result;
        }
        else { /* bad operation */
            if (validateOperation) {
                throw new JsonPatchError('Operation `op` property is not one of operations defined in RFC-6902', 'OPERATION_OP_INVALID', index, operation, document);
            }
            else {
                return returnValue;
            }
        }
    } /* END ROOT OPERATIONS */
    else {
        if (!mutateDocument) {
            document = _deepClone(document);
        }
        var path = operation.path || "";
        var keys = path.split('/');
        var obj = document;
        var t = 1; //skip empty element - http://jsperf.com/to-shift-or-not-to-shift
        var len = keys.length;
        var existingPathFragment = undefined;
        var key = void 0;
        var xConfig = void 0;
        var workingDocument = document;
        var graftPath = undefined;
        if (operation.op === 'x') {
            xConfig = xOpRegistry.get(operation.xid);
            if (!xConfig) {
                throw new JsonPatchError('Extended operation `xid` property is not a registered extended operation', 'OPERATION_X_OP_INVALID', index, operation, document);
            }
            // make another clone to allow configured operator to 'abort' or 'no op'
            // by returning a strict undefined
            workingDocument = obj = _deepClone(obj);
        }
        var validateFunction = void 0;
        if (typeof validateOperation == 'function') {
            validateFunction = validateOperation;
        }
        else {
            validateFunction = validator;
        }
        while (true) {
            key = keys[t];
            if (key && key.indexOf('~') != -1) {
                key = unescapePathComponent(key);
            }
            if (banPrototypeModifications &&
                (key == '__proto__' ||
                    (key == 'prototype' && t > 0 && keys[t - 1] == 'constructor'))) {
                throw new TypeError(PROTO_ERROR_MSG);
            }
            if (validateOperation) {
                if (existingPathFragment === undefined) {
                    if (obj[key] === undefined) {
                        existingPathFragment = keys.slice(0, t).join('/');
                    }
                    else if (t == len - 1) {
                        existingPathFragment = operation.path;
                    }
                    if (existingPathFragment !== undefined) {
                        validateFunction(operation, 0, document, existingPathFragment);
                    }
                }
            }
            t++;
            if (Array.isArray(obj)) {
                // don't coerce an empty key string into an integer (below w/~~)
                // if not in resolve mode (extended ops only)
                if (operation.op === 'x' && operation.resolve !== true && key === '') {
                    throw new JsonPatchError("Expected an unsigned base-10 integer value, making the new referenced value the array element with the zero-based index", "OPERATION_PATH_ILLEGAL_ARRAY_INDEX", index, operation, document);
                }
                if (key === '-') {
                    key = obj.length;
                    // make some adjustments for grafting with extended ops
                    if (operation.op === 'x') {
                        // update global keys array as well
                        keys[t - 1] = key.toString(10);
                        // set this point as the graft path
                        if (graftPath === undefined) {
                            graftPath = keys.slice(0, t).join('/');
                        }
                    }
                }
                // extended operations can use a special 'end element' sentinel in array paths
                else if (operation.op === 'x' && key === '--') {
                    key = obj.length - 1;
                    // update global keys array as well
                    keys[t - 1] = key.toString(10);
                    // set this point as the graft path
                    if (graftPath === undefined) {
                        graftPath = keys.slice(0, t).join('/');
                    }
                }
                else {
                    if (validateOperation && !isInteger(key)) {
                        throw new JsonPatchError("Expected an unsigned base-10 integer value, making the new referenced value the array element with the zero-based index", "OPERATION_PATH_ILLEGAL_ARRAY_INDEX", index, operation, document);
                    } // only parse key when it's an integer for `arr.prop` to work
                    else if (isInteger(key)) {
                        key = ~~key;
                        // don't allow arbitrary idx creation if not in resolve mode (extended ops only)
                        if (operation.op === 'x' && operation.resolve !== true && key >= obj.length) {
                            throw new JsonPatchError("The specified index MUST NOT be greater than the number of elements in the array", "OPERATION_VALUE_OUT_OF_BOUNDS", index, operation, document);
                        }
                    }
                }
                if (t >= len) {
                    if (operation.op === 'x' && xConfig) {
                        // maintain parity with empty root behavior above
                        if (typeof key === 'string' && key.length === 0 && !operation.resolve) {
                            return { newDocument: operation.value };
                        }
                        // Apply extended array patch
                        var result = xConfig.arr.call(operation, obj, key, workingDocument);
                        if (result === undefined) {
                            return { newDocument: document };
                        }
                        // check for ambiguous results
                        if (result.removed !== undefined && operation.resolve === true) {
                            // can't use resolve with a removal; ambiguous removal path
                            throw new JsonPatchError('Extended operation should not remove items while resolving undefined paths', 'OPERATION_X_AMBIGUOUS_REMOVAL', index, operation, document);
                        }
                        if (mutateDocument) {
                            // default graft path
                            var pc = {
                                modType: 'graft',
                                comps: graftPath === undefined ? keys.slice(1, t) : graftPath.split('/').slice(1),
                            };
                            // figure out graft or prune
                            if (result.removed !== undefined) {
                                // it's a prune
                                pc = {
                                    modType: 'prune',
                                    // use entire path up to, and including, key
                                    comps: keys.slice(1, t),
                                };
                            }
                            // modifies document in-place
                            _graftTree(result.newDocument, document, pc);
                            // make sure to return original document reference
                            return { newDocument: document };
                        }
                        return result;
                    }
                    if (validateOperation && operation.op === "add" && key > obj.length) {
                        throw new JsonPatchError("The specified index MUST NOT be greater than the number of elements in the array", "OPERATION_VALUE_OUT_OF_BOUNDS", index, operation, document);
                    }
                    var returnValue = arrOps[operation.op].call(operation, obj, key, document); // Apply patch
                    if (returnValue.test === false) {
                        throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', index, operation, document);
                    }
                    return returnValue;
                }
            }
            else {
                if (t >= len) {
                    if (operation.op === 'x' && xConfig) {
                        // maintain parity with empty root behavior above
                        if (key.length === 0 && !operation.resolve) {
                            return { newDocument: operation.value };
                        }
                        // Apply extended obj patch
                        var result = xConfig.obj.call(operation, obj, key, workingDocument);
                        if (result === undefined) {
                            return { newDocument: document };
                        }
                        if (mutateDocument) {
                            // default graft path
                            var pc = {
                                modType: 'graft',
                                comps: graftPath === undefined ? keys.slice(1, t) : graftPath.split('/').slice(1),
                            };
                            // figure out graft or prune
                            if (result.removed !== undefined) {
                                // it's a prune
                                pc = {
                                    modType: 'prune',
                                    // use entire path up to, and including, key
                                    comps: keys.slice(1, t),
                                };
                            }
                            // modifies document in-place
                            _graftTree(result.newDocument, document, pc);
                            // make sure to return original document reference
                            return { newDocument: document };
                        }
                        return result;
                    }
                    var returnValue = objOps[operation.op].call(operation, obj, key, document); // Apply patch
                    if (returnValue.test === false) {
                        throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', index, operation, document);
                    }
                    return returnValue;
                }
            }
            // extended operation forced path resolution
            if (operation.op === 'x' && xConfig && obj[key] === undefined) {
                // get first path where something isn't defined
                if (graftPath === undefined) {
                    graftPath = keys.slice(0, t).join('/');
                }
                if (operation.resolve === true) {
                    // add resolvable nodes
                    // check next key to determine object creation strategy
                    if (Array.isArray(document) && isInteger(String(keys[t]))) { // goofy cast
                        // if original document is an array, numeric path elements
                        // should add new arrays with minimum capacity
                        obj[key] = new Array(~~keys[t] + 1);
                    }
                    else {
                        obj[key] = {};
                    }
                }
            }
            obj = obj[key];
            // If we have more keys in the path, but the next value isn't a non-null object,
            // throw an OPERATION_PATH_UNRESOLVABLE error instead of iterating again.
            if (validateOperation && t < len && (!obj || typeof obj !== "object")) {
                throw new JsonPatchError('Cannot perform operation at the desired path', 'OPERATION_PATH_UNRESOLVABLE', index, operation, document);
            }
        }
    }
}
/**
 * Apply a full JSON Patch array on a JSON document.
 * Returns the {newDocument, result} of the patch.
 * It modifies the `document` object and `patch` - it gets the values by reference.
 * If you would like to avoid touching your values, clone them:
 * `jsonpatch.applyPatch(document, jsonpatch._deepClone(patch))`.
 *
 * @param document The document to patch
 * @param patch The patch to apply
 * @param validateOperation `false` is without validation, `true` to use default jsonpatch's validation, or you can pass a `validateOperation` callback to be used for validation.
 * @param mutateDocument Whether to mutate the original document or clone it before applying
 * @param banPrototypeModifications Whether to ban modifications to `__proto__`, defaults to `true`.
 * @return An array of `{newDocument, result}` after the patch
 */
export function applyPatch(document, patch, validateOperation, mutateDocument, banPrototypeModifications) {
    if (mutateDocument === void 0) { mutateDocument = true; }
    if (banPrototypeModifications === void 0) { banPrototypeModifications = true; }
    if (validateOperation) {
        if (!Array.isArray(patch)) {
            throw new JsonPatchError('Patch sequence must be an array', 'SEQUENCE_NOT_AN_ARRAY');
        }
    }
    if (!mutateDocument) {
        document = _deepClone(document);
    }
    var results = new Array(patch.length);
    for (var i = 0, length_1 = patch.length; i < length_1; i++) {
        // we don't need to pass mutateDocument argument because if it was true, we already deep cloned the object, we'll just pass `true`
        results[i] = applyOperation(document, patch[i], validateOperation, true, banPrototypeModifications, i);
        document = results[i].newDocument; // in case root was replaced
    }
    results.newDocument = document;
    return results;
}
/**
 * Apply a single JSON Patch Operation on a JSON document.
 * Returns the updated document.
 * Suitable as a reducer.
 *
 * @param document The document to patch
 * @param operation The operation to apply
 * @return The updated document
 */
export function applyReducer(document, operation, index) {
    var operationResult = applyOperation(document, operation);
    if (operationResult.test === false) { // failed test
        throw new JsonPatchError("Test operation failed", 'TEST_OPERATION_FAILED', index, operation, document);
    }
    return operationResult.newDocument;
}
/**
 * Validates a single operation. Called from `jsonpatch.validate`. Throws `JsonPatchError` in case of an error.
 * @param {object} operation - operation object (patch)
 * @param {number} index - index of operation in the sequence
 * @param {object} [document] - object where the operation is supposed to be applied
 * @param {string} [existingPathFragment] - comes along with `document`
 */
export function validator(operation, index, document, existingPathFragment) {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
        throw new JsonPatchError('Operation is not an object', 'OPERATION_NOT_AN_OBJECT', index, operation, document);
    }
    // check for extended ops
    if (operation.op === 'x') {
        // default validations
        if (!isValidExtendedOpId(operation.xid)) {
            throw new JsonPatchError('Operation `xid` property is not present or invalid string', 'OPERATION_X_ID_INVALID', index, operation, document);
        }
        var xConfig = xOpRegistry.get(operation.xid);
        if (!xConfig) {
            throw new JsonPatchError('Extended operation `xid` property is not a registered extended operation', 'OPERATION_X_OP_INVALID', index, operation, document);
        }
        if (typeof operation.path !== 'string') {
            throw new JsonPatchError('Operation `path` property is not a string', 'OPERATION_PATH_INVALID', index, operation, document);
        }
        if (operation.path.indexOf('/') !== 0 && operation.path.length > 0) {
            // paths that aren't empty string should start with "/"
            throw new JsonPatchError('Operation `path` property must start with "/"', 'OPERATION_PATH_INVALID', index, operation, document);
        }
        if (operation.path === '/') {
            throw new JsonPatchError('Operation `path` slash-only is ambiguous', 'OPERATION_PATH_UNRESOLVABLE', index, operation, document);
        }
        if (operation.args !== undefined && !Array.isArray(operation.args)) {
            throw new JsonPatchError('Operation `args` property is not an array', 'OPERATION_X_ARGS_NOT_ARRAY', index, operation, document);
        }
        // we made it this far, now run the operation's configured validator
        xConfig.validator.call(operation, operation, index, document, existingPathFragment);
    }
    else if (!objOps[operation.op]) {
        throw new JsonPatchError('Operation `op` property is not one of operations defined in RFC-6902', 'OPERATION_OP_INVALID', index, operation, document);
    }
    else if (typeof operation.path !== 'string') {
        throw new JsonPatchError('Operation `path` property is not a string', 'OPERATION_PATH_INVALID', index, operation, document);
    }
    else if (operation.path.indexOf('/') !== 0 && operation.path.length > 0) {
        // paths that aren't empty string should start with "/"
        throw new JsonPatchError('Operation `path` property must start with "/"', 'OPERATION_PATH_INVALID', index, operation, document);
    }
    else if ((operation.op === 'move' || operation.op === 'copy') && typeof operation.from !== 'string') {
        throw new JsonPatchError('Operation `from` property is not present (applicable in `move` and `copy` operations)', 'OPERATION_FROM_REQUIRED', index, operation, document);
    }
    else if ((operation.op === 'add' || operation.op === 'replace' || operation.op === 'test') && operation.value === undefined) {
        throw new JsonPatchError('Operation `value` property is not present (applicable in `add`, `replace` and `test` operations)', 'OPERATION_VALUE_REQUIRED', index, operation, document);
    }
    else if ((operation.op === 'add' || operation.op === 'replace' || operation.op === 'test') && hasUndefined(operation.value)) {
        throw new JsonPatchError('Operation `value` property is not present (applicable in `add`, `replace` and `test` operations)', 'OPERATION_VALUE_CANNOT_CONTAIN_UNDEFINED', index, operation, document);
    }
    else if (document) {
        if (operation.op == "add") {
            var pathLen = operation.path.split("/").length;
            var existingPathLen = existingPathFragment.split("/").length;
            if (pathLen !== existingPathLen + 1 && pathLen !== existingPathLen) {
                throw new JsonPatchError('Cannot perform an `add` operation at the desired path', 'OPERATION_PATH_CANNOT_ADD', index, operation, document);
            }
        }
        else if (operation.op === 'replace' || operation.op === 'remove' || operation.op === '_get') {
            if (operation.path !== existingPathFragment) {
                throw new JsonPatchError('Cannot perform the operation at a path that does not exist', 'OPERATION_PATH_UNRESOLVABLE', index, operation, document);
            }
        }
        else if (operation.op === 'move' || operation.op === 'copy') {
            var existingValue = { op: "_get", path: operation.from, value: undefined };
            var error = validate([existingValue], document);
            if (error && error.name === 'OPERATION_PATH_UNRESOLVABLE') {
                throw new JsonPatchError('Cannot perform the operation from a path that does not exist', 'OPERATION_FROM_UNRESOLVABLE', index, operation, document);
            }
        }
    }
}
/**
 * Validates a sequence of operations. If `document` parameter is provided, the sequence is additionally validated against the object document.
 * If error is encountered, returns a JsonPatchError object
 * @param sequence
 * @param document
 * @returns {JsonPatchError|undefined}
 */
export function validate(sequence, document, externalValidator) {
    try {
        if (!Array.isArray(sequence)) {
            throw new JsonPatchError('Patch sequence must be an array', 'SEQUENCE_NOT_AN_ARRAY');
        }
        if (document) {
            //clone document and sequence so that we can safely try applying operations
            applyPatch(_deepClone(document), _deepClone(sequence), externalValidator || true);
        }
        else {
            externalValidator = externalValidator || validator;
            for (var i = 0; i < sequence.length; i++) {
                externalValidator(sequence[i], i, document, undefined);
            }
        }
    }
    catch (e) {
        if (e instanceof JsonPatchError) {
            return e;
        }
        else {
            throw e;
        }
    }
}
// based on https://github.com/epoberezkin/fast-deep-equal
// MIT License
// Copyright (c) 2017 Evgeny Poberezkin
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
export function _areEquals(a, b) {
    if (a === b)
        return true;
    if (a && b && typeof a == 'object' && typeof b == 'object') {
        var arrA = Array.isArray(a), arrB = Array.isArray(b), i, length, key;
        if (arrA && arrB) {
            length = a.length;
            if (length != b.length)
                return false;
            for (i = length; i-- !== 0;)
                if (!_areEquals(a[i], b[i]))
                    return false;
            return true;
        }
        if (arrA != arrB)
            return false;
        var keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length)
            return false;
        for (i = length; i-- !== 0;)
            if (!b.hasOwnProperty(keys[i]))
                return false;
        for (i = length; i-- !== 0;) {
            key = keys[i];
            if (!_areEquals(a[key], b[key]))
                return false;
        }
        return true;
    }
    return a !== a && b !== b;
}
;
