#! /usr/bin/env node

// +++ Dependencies
var fse       = require('fs-extra');
var path      = require('path');
var nunjucks  = require('nunjucks');
var highlight = require('highlight.js');
var yaml      = require('js-yaml');
var _         = require('lodash');
var q         = require('q');
var program   = require('commander');
var promptly  = require('promptly');
// --- Dependencies


// +- CONFIG_FILENAME
var CONFIG_FILENAME = '_config.yml';

// +- MODULE_ROOT
var MODULE_ROOT = path.dirname(__filename);

// +- FILE_TYPE_...
var FILE_TYPE_SPECIAL = 'SPECIAL';
var FILE_TYPE_PAGE = 'PAGE';
var FILE_TYPE_VERBATIM = 'VERBATIM';


// +- CODE_REF_IN_HTML_REGEX
var CODE_REF_IN_HTML_REGEX = new RegExp([
    '\\s*',                         // Zero or more spaces
    '<ref\\s+',                     // "ref" tag opening
    'name="(.+)"',                  // The name of the reference (capture)
    '\\s*',                         // Zero or more spaces
    'file="(.+)"',                  // File where the reference is (capture)
    '\\s*',                         // Zero or more spaces
    '>'                             // Tag close
].join(''), 'g');

// +- BLOCK_CODE_REF_IN_SRC_REGEX
var BLOCK_CODE_REF_IN_SRC_REGEX = _.mapValues(
    fse.readJsonSync(path.join(MODULE_ROOT, 'languages.json')), function(obj) {
        return new RegExp([
            '[^\\S\\n]*',
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',
            '\\+{3}',                         // Three consecutive plus symbols
            '[^\\S\\n]*',
            '(.+)',                           // The name of the reference (capture)
            '\\n',                            // Newline
            '([\\s\\S]+)\\n',                 // The actual code (capture),
            '[^\\S\\n]*',
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',
            '\\-{3}',                         // Three consecutive minus symbols
            '[^\\S\\n]*',
            '\\1',                            // Same name reference of the comment start
        ].join(''), 'g')
    });

// +- SIMPLE_CODE_REF_IN_SRC_REGEX
var SIMPLE_CODE_REF_IN_SRC_REGEX = _.mapValues(
    fse.readJsonSync(path.join(MODULE_ROOT, 'languages.json')), function(obj) {
        return new RegExp([
            '[^\\S\\n]*',
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',
            '\\+\\-',                         // Three consecutive plus symbols
            '[^\\S\\n]*',
            '(.+)',                           // The name of the reference (capture)
            '\\n',                            // Newline
            '([\\s\\S]+?)\\n\\n',                 // The actual code (capture),
        ].join(''), 'g')
    });



// +++ fn main
function main() {
    consoleMessage('log', 'Static site generation started.');
    consoleMessage('log', 'Getting site configuration.');
    getConfiguration()
        .then(function(config) {
            fse.emptyDirSync(config.outputDir);
            parseFiles(config)
                .then(function(parsedFiles) {
                    return makeSite(parsedFiles, config);
                })
                .then(function() {
                    consoleMessage('log', 'Static site generation finished.');
                })
                .catch(function(err) {
                    consoleMessage('error', err);
                });
        })
        .catch(function(err) {
            consoleMessage('error', err);
        });

}
// --- fn main


// +++ fn getConfiguration
function getConfiguration() {
    var deferred = q.defer();

    var config = {};

    fse.readFile(CONFIG_FILENAME, 'utf-8', function(err, content) {
        if (err) {
            consoleMessage('warn', 'Configuration file not found, using defaults.');
        } else {
            try {
                _.extend(config, yaml.safeLoad(content));
            } catch(err) {
                consoleMessage('error', 'Could not parse configuration file, using defaults.');
            }
        }

        _.defaults(config, {
            inputDirAbsPath: path.resolve('.'),
            outputDir: '_site',
            codeDir: '..'
        });

        deferred.resolve(config);
    });

    return deferred.promise;
}
// --- fn getConfiguration



// +++ fn parseFiles
function parseFiles(config) {
    var deferred = q.defer();

    var SPECIAL_FILES_LIST = [
        '_config.yml',
        '_data',
        '_layouts',
        '_includes',
        config.outputDir
    ];

    var parsedFiles = [];

    fse.walk('.')
        .on('data', function(fileDesc) {
            fileDesc.pathRelativeToInputDir = path.relative(
                config.inputDirAbsPath, fileDesc.path);
            fileDesc.pathRelativeToOutputDir = path.join(
                config.outputDir, fileDesc.pathRelativeToInputDir);
            fileDesc.absoluteInputPath = fileDesc.path;
            fileDesc.absoluteOutputPath = path.join(
                config.inputDirAbsPath, fileDesc.pathRelativeToOutputDir);
            fileDesc.category = categorizeFile(fileDesc.pathRelativeToInputDir);
            parsedFiles.push(fileDesc);
        })
        .on('end', function() {
            deferred.resolve(parsedFiles);
        });

    return deferred.promise;

    // +++ fn categorizeFile
    function categorizeFile(filepath) {
        if (filepathIsSpecial(filepath)) {
            return FILE_TYPE_SPECIAL;
        }
        else if (filepathIsPage(filepath)) {
            return FILE_TYPE_PAGE;
        }
        else {
            return FILE_TYPE_VERBATIM;
        }
    }
    // --- fn categorizeFile

    // +++ fn filepathIsSpecial
    function filepathIsSpecial(filepath) {
        var root = filepath.split(path.sep)[0];
        return _.contains(SPECIAL_FILES_LIST, root);
    }
    // --- fn filepathIsSpecial

    // +++ fn filepathIsPage
    function filepathIsPage(filepath) {
        return path.extname(filepath) === '.html';
    }
    // --- fn filepathIsPage
}
// --- fn parseFiles



// +++ fn makeSite
function makeSite(parsedFiles, config) {
    var deferred = q.defer();

    var engine = new nunjucks.Environment(new nunjucks.FileSystemLoader(config.absoluteInputPath));
    var codeReferences = {};
    var context = {
        data: parseDataDir()
    };

    _.each(parsedFiles, function(fileDesc) {
        switch (fileDesc.category) {
        case FILE_TYPE_VERBATIM:
            if (fileDesc.stats.isDirectory()) {
                fse.mkdirpSync(fileDesc.absoluteOutputPath);
            }
            else {
                fse.ensureDirSync(path.dirname(fileDesc.absoluteOutputPath));
                fse.copySync(fileDesc.absoluteInputPath, fileDesc.absoluteOutputPath);
            }
            break;
        case FILE_TYPE_PAGE:
            try {
                consoleMessage('log', '\nRendering page-type file "' + fileDesc.pathRelativeToInputDir + '"');
                var rawHTML = fse.readFileSync(fileDesc.absoluteInputPath, 'utf-8');
                var renderedHTML = engine.renderString(rawHTML, context);
                var renderedHTMLWithCode = resolveCodeReferences(renderedHTML);
                fse.writeFileSync(fileDesc.absoluteOutputPath, renderedHTMLWithCode);
                consoleMessage('log', 'OK');
            } catch (err) {
                consoleMessage('error', err.toString());
            }
            break;
        case FILE_TYPE_SPECIAL:
            // DO NOTHING
            break;
        default:
            consoleMessage('error', 'Unexpected file type "' + fileDesc.category + '" of file "' + fileDesc.pathRelativeToInputDir +'"');
        }
    });

    deferred.resolve();

    return deferred.promise;


    function parseDataDir() {
        var dataFiles = fse.readdirSync('_data');
        var data = {};
        _.each(dataFiles, function(file) {
            if (!(path.extname(file) === '.yaml')) return;
            try {
                data[path.basename(file, '.yaml')] = yaml.safeLoad(fse.readFileSync(path.join('_data', file)));
            } catch(err) {
                consoleMessage('error', 'Error! Could not open or parse data file "' + file + '".');
            }
        });
        return data;
    }

    function resolveCodeReferences(html) {
        return html.replace(CODE_REF_IN_HTML_REGEX, function(match, name, file) {
            var lang = path.extname(file).slice(1);
            return [
                '<pre class="hljs"><code>',
                highlight.highlight(lang, getCodeOfReference(name, file)).value,
                '</pre></code>'
            ].join('');
        });
    }

    function getCodeOfReference(name, file) {
        if (_.isUndefined(codeReferences[file])) {
            makeCodeReferencesForFile(file);
        }

        var referencedCode = _.get(codeReferences, [file, name], undefined);
        var errorMessage = 'ERROR! Code reference "' + name + '" of file "' + file + '" not found.'

        if (_.isUndefined(referencedCode)) {
            consoleMessage('error', errorMessage);
            return errorMessage;
        }

        return referencedCode;
    }

    function makeCodeReferencesForFile(file) {
        var ext = path.extname(file);
        var reBlock = BLOCK_CODE_REF_IN_SRC_REGEX[ext];
        var reSimple = SIMPLE_CODE_REF_IN_SRC_REGEX[ext];
        var content = '';

        try {
            content = fse.readFileSync(path.join(config.codeDir, file), 'utf-8');
        } catch(err) {
            // DO NOTHING;
        }

        while ((match = reBlock.exec(content))) {
            var name = match[1];
            var code = match[2];
            _.set(codeReferences, [file, name], code);
            reBlock.lastIndex =
                reBlock.lastIndex - (match[0].length - match[0].split(/[\n\r]/)[0].length) + 1;
        }
        
        while ((match = reSimple.exec(content))) {
            var name = match[1];
            var code = match[2];
            _.set(codeReferences, [file, name], code);
        }
    }
}
// --- fn makeSite



// +++ fn consoleMessage
function consoleMessage(type, message) {
    var promptedMessage = 'scythe> ' + message.split(/[\n\r]/).join('\nscythe> ');
    console[type](promptedMessage);
}
// --- fn consoleMessage



function copyBootstrapTemplate() {
    fse.stat('docs', function(err, stats) {
        if (!err && stats.isDirectory()) {
            promptly.confirm('Dir "docs" already exists, continuing will delete it first. Continue? (y/n) ', function(err, confirmed) {
                if (confirmed) {
                    fse.removeSync('docs');
                    fse.copySync(path.join(MODULE_ROOT, 'bootstrap_template'), 'docs');
                }
            });
        } else {
            fse.copySync(path.join(MODULE_ROOT, 'bootstrap_template'), 'docs');
        }
    });
}


// +- cli configuration
program
    .version('0.1.0');

// +- cli mksite cmd
program
    .command('mksite')
    .description('Makes a static site out of the files in the cwd.')
    .action(main);

// +- cli mktemplate cmd
program
    .command('mktemplate')
    .description('Creates a "docs" directory with boilerplate.')
    .action(copyBootstrapTemplate)

program.parse(process.argv);
