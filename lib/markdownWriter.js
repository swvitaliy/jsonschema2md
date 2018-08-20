/**
 * Copyright 2017 Adobe Systems Incorporated. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

const writeFile = require('./writeFiles');
var Promise=require('bluebird');
var path = require('path');
var _ = require('lodash');
var ejs = require('ejs');
const pejs = Promise.promisifyAll(ejs);
var validUrl = require('valid-url');
const { headers } = require('./header');
var GithubSlugger = require('github-slugger');

function createGithubSlugs(names){
  var slugger = new GithubSlugger();
  slugger.reset();
  names = names.sort();
  return names.reduce(function(result, item) {
    result[item] = slugger.slug(item);
    return result;
  }, {});
}

function render([ template, context ]) {
  return pejs.renderFileAsync(template, context, { debug: false });
}

function build(total, fragment) {
  return total + fragment.replace(/\n\n/g, '\n');
}

function assoc(obj, key, value) {
  if (obj==null) {
    return assoc({}, key, value);
  }
  obj[key] = value;
  return obj;
}

function flatten(dependencies) {
  let deps = [];
  if (dependencies) {
    const key = _.keys(dependencies)[0];
    deps = _.toPairs(dependencies[key]).map(([ first, second ]) => {
      second.$id = first;
      return second;
    });
  }
  return deps;
}

function stringifyExamples(examples) {
  if (examples) {
    if (typeof examples === 'string') {
      examples = [ examples ];
    }
    //console.log(examples);
    return examples.map(example => {
      return JSON.stringify(example, null, 2);
    });
  } else {
    return false;
  }
}

/**
 * Finds a simple, one-line description of the property's type
 * @param {object} prop - a JSON Schema property definition
 */
function simpletype(prop) {
  //console.log('prop=%j', prop);
  const type = prop.type;
  if (prop.$ref!==undefined) {
    if (prop.$linkVal!==undefined) {
      prop.simpletype = prop.$linkVal;
    } else {
      console.log('unresolved reference: ' + prop.$ref);
      prop.simpletype = '`reference`';
    }
  } else if (prop.enum!==undefined) {
    prop.simpletype = '`enum`';
    if (prop['meta:enum']===undefined) {
      prop['meta:enum'] = {};
    }
    for (let i=0;i<prop.enum.length;i++) {
      if (prop['meta:enum'][prop.enum[i]]===undefined) {
        //setting an empty description for each unknown enum
        prop['meta:enum'][prop.enum[i]] = '';
      }
    }
  } else if (prop.const!==undefined) {
    prop.simpletype = '`const`';
  } else if (type==='string') {
    prop.simpletype = '`string`';
  } else if (type==='number') {
    prop.simpletype = '`number`';
  } else if (type==='boolean') {
    prop.simpletype = '`boolean`';
  } else if (type==='integer') {
    prop.simpletype = '`integer`';
  } else if (type==='object') {
    prop.simpletype = '`object`';
    this.resolve$ref(prop);
  } else if (type==='array') {
    if (prop.items!==undefined) {
      const innertype = simpletype.call(this, prop.items);
      this.resolveArray(prop);
      if (innertype.simpletype==='complex') {
        prop.simpletype = '`array`';
      } else {
        //console.log(prop.title);
        prop.simpletype = innertype.simpletype.replace(/(`)$/, '[]$1');
      }
    } else {
      prop.simpletype = '`array`';
    }
  } else {
    prop.simpletype = 'complex';
    console.warn("complex type %j", prop);
  }
  return prop;
}
/**
 * Combines the `required` array data structure with the `properties` map data
 * structure, so that each property in `properties` that is required, i.e. listed
 * as a value in the `required` array will have an additional property `isrequired`
 * @param {*} properties
 * @param {*} required
 * @param {*} schemaCtx
 */
function requiredProperties(properties, required, schemaCtx) {
  if (required) {
    for (let i=0;i<required.length;i++) {
      if (properties[required[i]]) {
        properties[required[i]].isrequired = true;
      }
    }
  }
  return _.mapValues(properties, simpletype.bind(schemaCtx));
}

function ejsRender(template, ctx) {
  let p = pejs.renderFileAsync(path.join(require('./options').get('templatePath'), template + '.ejs'), ctx, { debug: false });
  return p.value();
  //return JSON.stringify(obj, null, 2);
}

const generateMarkdown = function(filename, schema, schemaPath, outDir, dependencyMap, docs) {
  var ctx = {
    schema: schema,
    _: _,
    validUrl: validUrl,
    dependencyMap:dependencyMap
  };

  console.info('Generate file %s', filename);

  var simpletypeCtx = {
    resolve$ref: function (propSchema) {
      if (propSchema.$ref) {
        const name = propSchema.$ref.substr('#/definitions/'.length);
        propSchema.title = '`' + schema.definitions[name].title + '`';
        propSchema.$linkVal = schema.definitions[name].title;
      }
    },
    resolveArray: function (propSchema) {
      if (propSchema.items && propSchema.items.$ref && propSchema.items.$ref.startsWith('#/definitions/')) {
        const name = propSchema.items.$ref.substr('#/definitions/'.length);
        propSchema.title = '`' + schema.definitions[name].title + '[]`';
        propSchema.$linkVal = schema.definitions[name].title;
      }
    }
  };
  
  // resolve internal an array item definitions
  // console.log(schema.definitions);
  var resolveArrayProperties = function(props) {
    _.keys(props).forEach((property) => {
      let propSchema = props[property];
      simpletypeCtx.resolveArray(propSchema);
      props[property] = propSchema;
    });
    
    return props;
  };
    
  let propertiesSlugs = createGithubSlugs(_.keys(schema.properties));

  // this structure allows us to have separate templates for each element. Instead of having
  // one huge template, each block can be built individually
  let multi = [
    [ 'frontmatter.ejs', { meta: schema.metaElements } ],
    [ 'header.ejs', {
      schema: schema,
      dependencies: flatten(dependencyMap),
      table: headers(schema, schemaPath, filename, docs, outDir).render() } ],
    //[ 'divider.ejs', null ],
    //[ 'topSchema.ejs', ctx ],
    [ 'examples.ejs', { examples: stringifyExamples(schema.examples), title: schema.title } ]
  ];

  if (_.keys(schema.properties).length > 0) {
    //table of contents
    multi.push([ 'properties.ejs', {
      props: resolveArrayProperties(requiredProperties(schema.properties, schema.required, simpletypeCtx)),
      pprops: _.mapValues(schema.patternProperties, simpletype.bind(simpletypeCtx)),
      title: schema.title,
      additional: schema.additionalProperties,
      propertiesSlugs: propertiesSlugs,
    } ]);
    //regular properties
    for (let i=0; i<_.keys(schema.properties).length;i++) {
      const name = _.keys(schema.properties).sort()[i];
      multi.push( [ 'property.ejs', {
        name: name,
        required: schema.required ? schema.required.includes(name) : false,
        examples: stringifyExamples(schema.properties[name]['examples']),
        ejs: ejsRender,
        schema: simpletype.call(simpletypeCtx, schema.properties[name]),
        nameSlug: propertiesSlugs[name]
      } ]);
    }
    //patterns properties
    for (let i=0; i<_.keys(schema.patternProperties).length;i++) {
      const name = _.keys(schema.patternProperties)[i];
      multi.push( [ 'pattern-property.ejs', {
        name: name,
        examples: stringifyExamples(schema.patternProperties[name]['examples']),
        ejs: ejsRender,
        schema: simpletype.call(simpletypeCtx, schema.patternProperties[name]) } ]);
    }
  }
  //find definitions that contain properties that are not part of the main schema
  if (0 && _.keys(schema.definitions).length > 0) {
    const abstract = {};
    for (let i=0; i<_.keys(schema.definitions).length;i++) {
      if (schema.definitions[_.keys(schema.definitions)[i]].properties!==undefined) {
        const definition = schema.definitions[_.keys(schema.definitions)[i]].properties;
        for (let j=0; j<_.keys(definition).length;j++) {
          const name = _.keys(definition)[j];
          const property = definition[_.keys(definition)[j]];
          //console.log('Checking ' + name + ' against ' + _.keys(schema.properties));
          if (_.keys(schema.properties).indexOf(name)===-1) {
            property.definitiongroup = _.keys(schema.definitions)[i];
            abstract[name] = property;
          }
        }
      }
    }
    propertiesSlugs = createGithubSlugs(_.keys(abstract));
    if (_.keys(abstract).length>0) {
      //console.log('I got definitions!', abstract);
      multi.push([ 'definitions.ejs', {
        props: requiredProperties(abstract, undefined, simpletypeCtx),
        title: schema.title,
        id: schema.$id,
        propertiesSlugs:propertiesSlugs
      } ]);
      for (let i=0; i<_.keys(abstract).length;i++) {
        const name = _.keys(abstract).sort()[i];
        multi.push( [ 'property.ejs', {
          name: name,
          required: false,
          ejs: ejsRender,
          examples: stringifyExamples(abstract[name]['examples']),
          schema: simpletype.call(simpletypeCtx, abstract[name]),
          nameSlug: propertiesSlugs[name]
        } ]);
      }
    }
  }

  multi = multi.map(([ template, context ]) => {
    return [
      path.join(require('./options').get('templatePath'), template),
      assoc(assoc(context, '_', _), 'simpletype', simpletype.bind(simpletypeCtx))
    ];
  });

  return Promise.reduce(Promise.map(multi, render), build, '').then(str => {
    //console.log('Writing markdown (promise)');
    const mdfile = path.basename(filename).slice(0, -5)+ '.md';
    return writeFile(path.join(path.join(outDir), path.dirname(filename.substr(schemaPath.length))), mdfile, str);
  }).then(out => {
    //console.log('markdown written (promise)', out);
    return out;
  });
};

module.exports = generateMarkdown;
