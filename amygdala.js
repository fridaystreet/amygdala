'use strict';

// CommonJS check so we can require dependencies
if (typeof module === 'object' && module.exports) {
  var _ = require('underscore');
  var Q = require('q');
  var EventEmitter = require('wolfy87-eventemitter');
}

var Amygdala = function(options) {
  // Initialize a new Amygdala instance with the given schema and options.
  //
  // params:
  // - options (Object)
  //   - config (apiUrl, headers)
  //   - schema
  this._config = options.config;
  this._schema = options.schema;
  this._headers = this._config.headers;

  if (!this._config.storeId) {
    this._config.storeId = 'base';
  }
  // memory data storage
  this._stores = {};
  this._store = {};
  this._changeEvents = {};
  this._fetchedTypes = {};

  this.setLocalStorage(true);
};

Amygdala.prototype = _.clone(EventEmitter.prototype);

// ------------------------------
// Helper methods
// ------------------------------

Amygdala.prototype._getHeaders = function getHeaders() {

  var headers = {};
  _.forEach(this._headers, function(value, header){
    if (_.isFunction(value)) {
      headers[header] = value();
      return;
    }
    headers[header] = value;
  });
  return headers;
};

Amygdala.prototype.setLocalStorage = function setLocalStorage(silent) {

  if (this._config.localStorage) {
    _.each(this._schema, function(value, key) {
      // check each schema entry for localStorage data
      // TODO: filter out apiUrl and idAttribute
      var storageCache = window.localStorage.getItem('store-' + this._config.storeId + '-' + key);
      if (storageCache) {
        this._set(key, JSON.parse(storageCache), {'silent': true} );
      }
    }.bind(this));

    // store every change on local storage
    // when localStorage is set to true
    this.on('change', function(type) {
      this.setCache(type, this.findAll(type));
    }.bind(this));
  }
};

Amygdala.prototype.setStoreId = function setStoreId(id) {

  if (id === 'base') {
    throw new Error("store id base is an internal name and can't be used");
  }

  if (this._config.storeId === id) {
    return;
  }

  var oldStore = _.cloneDeep(this._store);
  // this._stores[this._config.storeId] = oldStore;
  this._stores[id] = this._stores[id] || {};
  this._store = this._stores[id];
  this._config.storeId = id;

  this.setLocalStorage();
  _.each(this._schema, (function(value, type) {
    if (value.segment) {
      if (this._fetchedTypes[type]) {
        this.get(type);
        return;
      }
      this._store[type] = {};
      return;
    }
    this._store[type] = _.cloneDeep(oldStore[type]);
  }).bind(this));
};

Amygdala.prototype.serialize = function serialize(obj) {
  // Translates an object to a querystring

  if (!_.isObject(obj)) {
    return obj;
  }
  var pairs = [];
  _.each(obj, function(value, key) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  });
  return pairs.join('&');
}

Amygdala.prototype.ajax = function ajax(method, url, options) {
   // Sends an Ajax request, converting the data into a querystring if the
   // method is GET.
   //
   // params:
   // -method (string): GET, POST, PUT, DELETE
   // -url (string): The url to send the request to.
   // -options (Object)
   //
   // options
   // - data (Object): Will be converted to a querystring for GET requests.
   // - contentType (string): A value for the Content-Type request header.
   // - headers (Object): Additional headers to add to the request.
  var query;
  options = options || {};

  if (url === '__LOCAL__') {
    if (method === 'GET') {
      if (!_.isEmpty(options.data) && options.data.localCreateTime) {
        return Q(this.find(options.type, options.data));
      }
      return Q(this.findAll(options.type, options.data));
    }
    return Q(options.data);
  }

  if (!_.isEmpty(options.data) && method === 'GET') {
    var opts = _.cloneDeep(options.data);
    delete opts[this._config.idAttribute];
    query = this.serialize(options.data);
    url = url + '?' + query;
  }

  var request = new XMLHttpRequest();
  var deferred = Q.defer();

  request.open(method, url, true);

  request.onload = function() {


    var resp;
    if (_.isString(request.response)) {
      // If the response is a string, try JSON.parse.
      try {
        resp = JSON.parse(request.response);
      } catch(e) {
        return deferred.reject(new Error('Invalid JSON from the API response.'));
      }
    }
    // status 200 OK, 201 CREATED, 20* ALL OK
    if (request.status.toString().substr(0, 2) === '20') {
      if (_.isObject(resp)) {
        if (resp.errorMessage) {
          console.log(resp);
          return deferred.reject(new Error('Request returned an unknown error: ' + resp.errorMessage));
        }
      }
      return deferred.resolve(request);
    }
    return deferred.reject(new Error(resp.errorMessage || 'Request failed with status code ' + request.status));
  };

  request.onerror = function() {
    deferred.reject(new Error('Unabe to send request to ' + JSON.stringify(url)));
  };

  if (!_.isEmpty(options.contentType)) {
    request.setRequestHeader('Content-Type', options.contentType);
  }

  if (!_.isEmpty(options.headers)) {
    _.each(options.headers, function(value, key) {
      request.setRequestHeader(key, value);
    });
  }

  request.send(method === 'GET' ? null : options.data);

  return deferred.promise;
}

// ------------------------------
// Internal utils methods
// ------------------------------
Amygdala.prototype._getURI = function(type, params) {
  var url;
  // get absolute uri for api endpoint
  if (!this._schema[type] || !this._schema[type].url) {
    throw new Error('Invalid type. Acceptable types are: ' + Object.keys(this._schema));
  }
  url = this._config.apiUrl + this._schema[type].url;
  // if the `idAttribute` specified by the config
  // exists as a key in `params` append it's value to the url,
  // and remove it from `params` so it's not sent in the query string.
  if (params && this._config.idAttribute in params) {
    url += '/' + params[this._config.idAttribute];
    //delete params[this._config.idAttribute];
  }

  if (this._schema[type].localDataOnly) {
    url = '__LOCAL__';
    params = params || {};
    params.type = type;
  }

  return url;
},

Amygdala.prototype._emitChange = function(type) {

  // TODO: Add tests for debounced events
  if (!this._changeEvents[type]) {
    this._changeEvents[type] = _.debounce(_.partial(function(type) {
      // emit changes events
      this.emit('change', type);
      // change:<type>
      this.emit('change:' + type);
      // TODO: compare the previous object and trigger change events
    }.bind(this), type), 150);
  }

  this._changeEvents[type]();
}

// ------------------------------
// Internal data sync methods
// ------------------------------
Amygdala.prototype._set = function(type, response, options) {
  // Adds or Updates an item of `type` in this._store.
  //
  // type: schema key/store (teams, users)
  // ajaxResponse: response to store in local cache

  // initialize store for this type (if needed)
  // and store it under `store` for easy access.

  options = options || {};
  var schema = this._schema[type];
  var store = this._store[type] ? this._store[type] : this._store[type] = {};

  if (_.isString(response)) {
    // If the response is a string, try JSON.parse.
    try {
      response = JSON.parse(response);
    } catch(e) {
      throw('Invalid JSON from the API response.');
    }
  }

  if (response[type] || response[_.startCase(type)]) {
    response = response[type] || response[_.startCase(type)];
  }

  if (!_.isArray(response)) {
    // The response isn't an array. We need to figure out how to handle it.

    if (schema.parse) {
      // Prefer the schema's parse method if one exists.
      response = schema.parse(response);
      // if it's still not an array, wrap it around one
      if (!_.isArray(response)) {
        response = [response];
      }
    } else {
      // Otherwise, just wrap it in an array and hope for the best.
      response = [response];
    }
  }


  //TODO need to handle if response is for entire store of single item
  //shouldn't delete store for single item
  //maybe check if there was a query with request. if no query then
  //server side store is empty

    //if the response length is 0 reset the store
  // if (!response.length) {
  //   //if the previous store is not empty then empty it and fire a change event
  //   if (_.size(store) !== 0) {
  //     this._store[type] = {};
  //     if (!options || options.silent !== true) {
  //       this._emitChange(type);
  //     }
  //   }
  //   return;
  // }

  var responseIds = _.map(response, this._config.idAttribute);
  if (options.noQuery) {
    _.forEach(store, (function(obj){
      if (obj[this._config.idAttribute] && responseIds.indexOf(obj[this._config.idAttribute]) === -1) {
        delete store[obj[this._config.idAttribute]];
      }
    }).bind(this));
  }

  var promises = [];
  _.each(response, function(obj) {

    // store the object under this._store['type']['id']

    var oldVersion = store[obj.localCreateTime] || store[obj[this._config.idAttribute]];
    oldVersion = oldVersion || obj;

    if (obj[this._config.idAttribute]) {
      if (store[obj.localCreateTime]) {
        store[obj.localCreateTime] = obj;
      } else {
        store[obj[this._config.idAttribute]] = obj;
      }
    } else {
      store[obj.localCreateTime] = obj;
    }

    //TODO not sure about this. it's to handle populated related objects coming from server
    //don't need it right now, but it interferes with updating local items
    // // handle oneToMany relations
    // _.each(this._schema[type].oneToMany, function(relatedType, relatedAttr) {
    //   // var related = obj[relatedAttr];
    //   // check if obj has a `relatedAttr` that is defined as a relation
    //   if (obj[relatedAttr]) {
    //     // check if attr value is an array,
    //     // if it's not empty, and if the content is an object and not a string
    //     if (_.isArray(obj[relatedAttr]) && _.isObject(_.first(obj[relatedAttr]))) {
    //       // if related is a list of objects,
    //       // populate the relation `table` with this data
    //       //this._set(relatedType, obj[relatedAttr]);
    //       // and replace the list of objects within `obj`
    //       // by a list of `id's.
    //       //Why do this. it just means we need to do get related on it later
    //       // obj[relatedAttr] = _.map(related, function(item) {
    //       //   return item[this._config.idAttribute];
    //       // }.bind(this));
    //     }
    //   }
    // }.bind(this));
    //
    // // handle foreignKey relations
    // _.each(this._schema[type].foreignKey, function(relatedType, relatedAttr) {
    //   // var related = obj[relatedAttr];
    //   // check if obj has a `relatedAttr` that is defined as a relation
    //   if (obj[relatedAttr]) {
    //     // check if `obj[relatedAttr]` value is an object (FK should not be arrays),
    //     // if it's not empty, and if the content is an object and not a string
    //     if (_.isArray(obj[relatedAttr])) {
    //       obj[relatedAttr] = _.first(obj[relatedAttr]);
    //     }
    //
    //     if (_.isObject(obj[relatedAttr])) {
    //       // if related is an object,
    //       // populate the relation `table` with this data
    //       //this._set(relatedType, [obj[relatedAttr]]);
    //       // and replace the list of objects within `item`
    //       // by a list of `id's
    //       //again, don't do this it doesn't make sense
    //       // obj[relatedAttr] = related[this._config.idAttribute];
    //       return;
    //     }
    //     // obj[relatedAttr] = related;
    //   }
    // }.bind(this));

    // obj.related()
    // set up a related method to fetch other related objects
    // as defined in the schema for the store.
    obj.getRelated = _.partial(function(schema, obj, attributeName) {

      obj = _.cloneDeep(obj);
      var promises = [];

      _.each(_.merge(_.cloneDeep(schema.oneToMany), _.cloneDeep(schema.foreignKey)), (function(serverAttr, localAttr){
        if (!attributeName || (attributeName && attributeName === localAttr)) {

          if (!obj[localAttr]) {
            return;
          }
          if (!_.isArray(obj[localAttr])) {
            obj[localAttr] = [obj[localAttr]];
          }

          _.map(obj[localAttr], (function(value) {
            // find in related `table` by id

            var id = value[this._config.idAttribute] || value;

            var promise = Q(this.find(serverAttr, id))
            .then((function(data){
              if (!_.isObject(data)) {
                return this.get(serverAttr, {[this._config.idAttribute]: id})
                .then(function(result) {
                  return {
                    attr: localAttr,
                    value: result
                  };
                });
              }
              return {
                attr: localAttr,
                value: data
              };
            }).bind(this));

            obj[localAttr] = [];
            promises.push(promise);
          }.bind(this)));
        }
      }).bind(this));

      return Q.all(promises)
      .then(function(responses){
        _.each(responses, function(item) {

          if (_.isObject(schema.oneToMany) && item.attr in schema.oneToMany) {
            obj[item.attr].push(item.value);
            return;
          }
          obj[item.attr] = item.value
        });
        return obj;
      });

    }.bind(this), schema, obj);

    obj.update = _.partial(function(store, oldVersion, type, data) {

      if (data) {
        _.forEach(data, (function(value, prop) {
          this[prop] = value;
        }).bind(this));
      }

      var promises = _.filter(_.map(store._model[type].config.validation, (function(field){
        if (_.isFunction(field.afterUpdate) && _.get(this, field.path) !== _.get(oldVersion, field.path)) {
          var promise = Q()
          .then((function(){
            return field.afterUpdate(store, store._config.idAttribute, this);
          }).bind(this));
          return promis;
        }
      }).bind(this)));

      if (promises.length) {
        return Q.all(promises)
        .then((function(result){
          // emit change events
          store._set(type, this);
          return this;
        }).bind(this));
      }

      store._set(type, this);
      return Q(this);
    }, this, oldVersion, type);

    obj.delete = _.partial(function(store, type, data) {
      return store.remove(type, this);
    }, this, type);

    obj.save = _.partial(function(store, oldVersion, type, options) {
      // POST/PUT request for `object` in `type`
      //
      // type: schema key/store (teams, users)
      // object: object to update local and remote
      // options: extra options
      // -  url: url override

      // Default to the URI for 'type'
      options = options || {};
      _.defaults(options, {'url': store._getURI(type)});

      var url = this.url;

      if (!url && store._config.idAttribute in this) {
        url = store._getURI(type, this);
      }

      var data = store._reduceRelated(type, _.cloneDeep(this));
      if (!url) {
        if (store._config.entityRoot) {
          data = {
            [_.startCase(type)]: data
          };
        }

        return store._post(options.url, data)
        .then((function(request){
          if (!request.response) {
            throw new Error('Save failed, invalid response from server');
          }
          var response;
          if (_.isString(request.response)) {
            // If the response is a string, try JSON.parse.
            try {
              response = JSON.parse(request.response);
            } catch(e) {
              throw new Error('Invalid JSON from the API response.');
            }
          }

          if (store._config.entityRoot) {
            response = response[_.startCase(type)];
          }

          _.forEach(response, (function(value, field){
            if (!this[field] || !_.isArray(value)) {
              this[field] = value;
              return;
            }
          }).bind(this));

          var promises = _.filter(_.map(store._model[type].config.validation, (function(field){
            if (_.isFunction(field.afterUpdate) && _.get(this, field.path) !== _.get(oldVersion, field.path)) {
              var promise = Q()
              .then((function(){
                return field.afterUpdate(store, store._config.idAttribute, this);
              }).bind(this));
              return promis;
            }
          }).bind(this)));

          if (promises.length) {
            return Q.all(promises)
            .then((function(result){
              // emit change events
              store._set(type, this, options);
              return this;
            }).bind(this));
          }

          store._set(type, this, options);
          return this;
        }).bind(this));
      }
      if (options.noUpdate) {
        return Q(this);
      }
      return store.update(type, this);
    }, this, oldVersion, type);

  }.bind(this));

  // emit change events
  if (!options || options.silent !== true) {
    this._emitChange(type);
  }

  // return our data as the original api call's response
  return response.length === 1 ? response[0] : response;
};

Amygdala.prototype._setAjax = function(type, request, options) {

  var baseUrl = this._getURI(type);

  if (this._schema[type].scope) {
    baseUrl += '?scopeType=' + this._schema[type].scope;
    baseUrl += '&scopeId=' + GlobalQueryParams[this._schema[type].scope];
  }

  if (request.responseURL === baseUrl) {
    options = {
      noQuery: true
    };
  }
  return this._set(type, request.response, options);
}

Amygdala.prototype._remove = function(type, object) {
  // Removes an item of `type` from this._store.
  //
  // type: schema key/store (teams, users)
  // response: response to store in local cache

  // delete object of type by id
  delete this._store[type][object.localCreateTime ];
  this._emitChange(type);
  return true;
};

Amygdala.prototype._validateURI = function(url) {
  // convert paths to full URLs
  // TODO: DRY UP
  if (url.indexOf('/') === 0) {
    return this._config.apiUrl + url;
  }

  return url;
}

Amygdala.prototype._reduceRelated = function(type, object) {

  _.each(this._schema[type].oneToMany, function(relatedType, relatedAttr) {
    var related = object[relatedAttr];
    // check if obj has a `relatedAttr` that is defined as a relation
    if (related) {
      // check if attr value is an array,
      // if it's not empty, and if the content is an object and not a string
      if (_.isArray(related) && related.length) {
        object[relatedAttr] = _.map(related, (function(item){
          if (_.isObject(item)) {
            return item[this._config.idAttribute];
          }
          return item;
        }).bind(this));
      }
    }
  }.bind(this));

  // handle foreignKey relations
  _.each(this._schema[type].foreignKey, function(relatedType, relatedAttr) {
    var related = object[relatedAttr];
    // check if obj has a `relatedAttr` that is defined as a relation
    if (related) {
      // check if `obj[relatedAttr]` value is an object (FK should not be arrays),
      // if it's not empty, and if the content is an object and not a string
      if (_.isArray(related)) {
        object[relatedAttr] = _.first(_.map(related, (function(item){
          if (_.isObject(item)) {
            return item[this._config.idAttribute];
          }
          return item;
        }).bind(this)));
        return;
      }
      if (_.isObject(related)) {
        // and replace the list of objects within `item`
        // by a list of `id's
        object[relatedAttr] = related[this._config.idAttribute];
      }
    }
  }.bind(this));

  return object;
};

// ------------------------------
// Public data sync methods
// ------------------------------
Amygdala.prototype._get = function(url, params) {
  // AJAX post request wrapper
  // TODO: make this method public in the future

  // Request settings
  var settings = {
    'data': params,
    'headers': this._getHeaders()
  };

  return this.ajax('GET', this._validateURI(url), settings);
}

Amygdala.prototype.get = function(type, params, options) {
  // GET request for `type` with optional `params`
  //
  // type: schema key/store (teams, users)
  // params: extra queryString params (?team=xpto&user=xyz)
  // options: extra options
  // - url: url override

  // Default to the URI for 'type'
  if (!params && !options) {
    this._fetchedTypes[type] = true;
  }


  if (this._schema[type].segment && this._config.storeId === 'base') {
    return Q([]);
  }

  if (this._schema[type].scope) {
    params = params || {};
    params.scopeType = this._schema[type].scope;
    params.scopeId = GlobalQueryParams[this._schema[type].scope]
  }

  options = options || {};
  _.defaults(options, {'url': this._getURI(type, params)});

  return this._get(options.url, params)
    .then(_.partial(this._setAjax, type).bind(this));
};

Amygdala.prototype._post = function(url, data) {
  // AJAX post request wrapper
  // TODO: make this method public in the future

  // Request settings
  var settings = {
    'data': data ? JSON.stringify(data) : null,
    'contentType': 'application/json',
    'headers': this._getHeaders()
  };

  return this.ajax('POST', this._validateURI(url), settings);
}

Amygdala.prototype.add = function(type, object, options) {
  // POST/PUT request for `object` in `type`
  //
  // type: schema key/store (teams, users)
  // object: object to update local and remote
  // options: extra options
  // -  url: url override

  object = _.cloneDeep(object);


  // Default to the URI for 'type'
  options = options || {};
  _.defaults(options, {'url': this._getURI(type)});

  object = this._reduceRelated(type, object);


  if (options.save) {
    if (this._config.entityRoot) {
      object = {
        [_.startCase(type)]: object
      };
    }

    return this._post(options.url, object)
      .then(_.partial(this._setAjax, type).bind(this));
  }

  object.localCreateTime = _.uniqueId((new Date()).getTime());
  return Q(this._set(type, object, options));
};

Amygdala.prototype._put = function(url, data) {
  // AJAX put request wrapper
  // TODO: make this method public in the future

  // Request settings
  var settings = {
    'data': JSON.stringify(data),
    'contentType': 'application/json',
    'headers': this._getHeaders()
  };

  return this.ajax('PUT', this._validateURI(url), settings);
}

Amygdala.prototype.update = function(type, object) {
  // POST/PUT request for `object` in `type`
  //
  // type: schema key/store (teams, users)
  // object: object to update local and remote

  object = _.cloneDeep(object);

  var url = object.url;

  object = this._reduceRelated(type, object);

  if (!url && this._config.idAttribute in object) {
    url = this._getURI(type, object);
  }

  if (!url) {
    if (object.localCreateTime) {
      return Q(this._set(type, object));
    }
    return Q.reject(new Error('Missing required object.url or ' + this._config.idAttribute + ' attribute.'));
  }

  if (this._config.entityRoot) {
    object = {
      [_.startCase(type)]: object
    };
  }

  return this._put(url, this._reduceRelated(type, object))
    .then(_.partial(this._setAjax, type).bind(this));
};

Amygdala.prototype._delete = function(url, data) {
  // AJAX delete request wrapper
  // TODO: make this method public in the future
  var settings = {
    'data': JSON.stringify(data),
    'contentType': 'application/json',
    'headers': this._getHeaders()
  };

  return this.ajax('DELETE', this._validateURI(url), settings);
};

Amygdala.prototype.remove = function(type, object) {
  // DELETE request for `object` in `type`
  //
  // type: schema key/store (teams, users)
  // object: object to update local and remote

  object = _.cloneDeep(object);


  var url = object.url;

  if (!url && this._config.idAttribute in object) {
    var id = object[this._config.idAttribute];
    url = this._getURI(type, object);
    object[this._config.idAttribute] = id;
  }

  if (!url) {
    if (object.localCreateTime) {
      return Q()
      .then((function(){
        return this._remove(type, object);
      }).bind(this));
    }
    return Q.reject(new Error('Missing required object.url or ' + this._config.idAttribute + ' attribute.'));
  }

  return this._delete(url, object)
    .then(_.partial(this._remove, type, object).bind(this));
};

// ------------------------------
// Public cache methods
// ------------------------------
Amygdala.prototype.setCache = function(type, objects) {
  if (!type) {
    throw new Error('Missing schema type parameter.');
  }
  if (!this._schema[type]) {
    throw new Error('Invalid type. Acceptable types are: ' + Object.keys(this._schema));
  }
  return window.localStorage.setItem('store-' + this._config.storeId + '-' + type, JSON.stringify(objects));
};

Amygdala.prototype.getCache = function(type) {
  if (!type) {
    throw new Error('Missing schema type parameter.');
  }
  if (!this._schema[type] || !this._schema[type].url) {
    throw new Error('Invalid type. Acceptable types are: ' + Object.keys(this._schema));
  }
  return JSON.parse(window.localStorage.getItem('store-' + this._config.storeId + '-' + type));
};

// ------------------------------
// Public query methods
// ------------------------------
Amygdala.prototype.findAll = function(type, query) {
  // find a list of items within the store. (THAT ARE NOT STORED IN BACKBONE COLLECTIONS)
  var store = this._store[type];
  var orderBy;
  var reverseMatch;
  var results;
  if (!store || !Object.keys(store).length) {
    return [];
  }
  if (query === undefined) {
    // query is empty, no object is returned
    results = _.map(store, function(item) { return item; });
  } else if (Object.prototype.toString.call(query) === '[object Object]') {
    // if query is an object, assume it specifies filters.
    results = _.filter(store, function(item) { return _.find([item], query); });
  } else {
    throw new Error('Invalid query for findAll.');
  }
  orderBy = this._schema[type].orderBy;
  if (orderBy) {
    // match the orderBy attribute for the presence
    // of a reverse flag
    reverseMatch = orderBy.match(/^-([\w-]{0,})$/);
    if (reverseMatch !== null) {
      // if we have two matches, we have a reverse flag
      orderBy = orderBy.replace('-', '');
    }
    results = _.sortBy(results, function(item) {
      return item[orderBy].toString().toLowerCase();
    }.bind(this));

    if (reverseMatch !== null) {
      // reverse the results
      results = results.reverse();
    }
  }
  return results;
};

Amygdala.prototype.find = function(type, query) {
  // find a specific within the store. (THAT ARE NOT STORED IN BACKBONE COLLECTIONS)
  var store = this._store[type];
  if (!store || !Object.keys(store).length) {
    return undefined;
  }
  if (query === undefined) {
    // query is empty, no object is returned
    return  undefined;
  }

  if (_.isObject(query) && !_.isArray(query)) {
    // if query is an object, return the first match for the query
    return _.find(store, query);
  }

  if (_.isString(query) || _.isNumber(query)) {
    // if query is a String, assume it stores the key/url value
    return store[query];
  }

  throw new Error('query must be string, number or object');

};

// expose via CommonJS, AMD or as a global object
if (typeof module === 'object' && module.exports) {
  module.exports = Amygdala;
} else if (typeof define === 'function' && define.amd) {
  define(function() {
    return Amygdala;
  });
} else {
  window.Amygdala = Amygdala;
}


