<?php

namespace Local\SectionTools;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use Statamic\Statamic;
use Statamic\Providers\AddonServiceProvider;
use Symfony\Component\Yaml\Yaml;

class ServiceProvider extends AddonServiceProvider
{
    public function bootAddon(): void
    {
        // The host app loads the CP script through its Vite pipeline in local development.

        Statamic::pushCpRoutes(function () {
            Route::get('section-tools/mammoth.js', function () {
                $path = __DIR__ . '/../resources/dist/mammoth.browser.min.js';
                return response()->file($path, ['Content-Type' => 'application/javascript']);
            });

            Route::post('section-tools/ai/chat', function (Request $request) {
                // Decode with json_decode(..., false) so JSON objects become stdClass,
                // not PHP arrays. This preserves {} vs [] at every nesting depth when
                // re-encoding, fixing the PHP [] → Anthropic {} mismatch completely.
                $raw = json_decode($request->getContent(), false);

                $payload = [
                    'model'      => env('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
                    'max_tokens' => isset($raw->max_tokens) ? (int) $raw->max_tokens : (int) env('ANTHROPIC_MAX_TOKENS', 1024),
                    'messages'   => $raw->messages ?? [],
                ];

                if (!empty($raw->system ?? null)) {
                    $payload['system'] = $raw->system;
                }

                if (!empty($raw->tools ?? null)) {
                    $payload['tools'] = $raw->tools;
                }

                $response = Http::timeout(180)->withHeaders([
                    'x-api-key'         => env('ANTHROPIC_API_KEY'),
                    'anthropic-version' => '2023-06-01',
                ])->post('https://api.anthropic.com/v1/messages', $payload);

                if ($response->status() >= 400) {
                    \Illuminate\Support\Facades\Log::error('Anthropic error', ['status' => $response->status(), 'body' => $response->json()]);
                }

                return response()->json($response->json(), $response->status());
            });

            Route::get('section-tools/blueprint', function (Request $request) {
                $collection = trim($request->get('collection', ''));
                $blueprint  = trim($request->get('blueprint', 'default'));

                $empty = ['fields' => [], 'sets' => []];
                if ($collection === '') return response()->json($empty);

                $bp = \Statamic\Facades\Blueprint::find("collections/{$collection}/{$blueprint}");
                if (!$bp) return response()->json($empty);

                $OPTION_TYPES     = ['select', 'radio', 'button_group', 'checkboxes', 'dictionary'];
                $REPLICATOR_TYPES = ['replicator', 'bard'];

                // Recursively build one level of the sets tree from a raw sets config array.
                // Returns { setHandle => { display, fields, sets? } } — no _root_field or
                // _parent_set needed; location in the tree encodes that context exactly.
                $extractSetsLevel = null;
                $extractSetsLevel = function (array $rawSets) use (
                    &$extractSetsLevel, $OPTION_TYPES, $REPLICATOR_TYPES
                ): array {
                    $level = [];
                    foreach ($rawSets as $key => $config) {
                        if (!is_array($config)) continue;

                        // Statamic 4 group: { display, sets: {...} } without fields
                        if (isset($config['sets']) && is_array($config['sets']) && !isset($config['fields'])) {
                            $level = array_merge($level, $extractSetsLevel($config['sets']));
                            continue;
                        }

                        // Transparent wrapper — recurse into its values
                        if (!isset($config['fields'])) {
                            $level = array_merge($level, $extractSetsLevel($config));
                            continue;
                        }

                        // Set type: expand fieldset imports first
                        $expandedFieldConfigs = [];
                        foreach ($config['fields'] ?? [] as $fc) {
                            if (!isset($fc['handle']) && !empty($fc['import'])) {
                                $importFs = \Statamic\Facades\Fieldset::find($fc['import']);
                                if ($importFs) {
                                    foreach ($importFs->contents()['fields'] ?? [] as $ifc) {
                                        $expandedFieldConfigs[] = $ifc;
                                    }
                                }
                            } else {
                                $expandedFieldConfigs[] = $fc;
                            }
                        }

                        $setFields  = [];
                        $nestedSets = []; // fieldHandle => sets level

                        foreach ($expandedFieldConfigs as $fieldConfig) {
                            $fieldHandle = $fieldConfig['handle'] ?? null;
                            if (!$fieldHandle) continue;

                            // Field def may be inline, a "fieldset.handle" reference, or flat.
                            $fieldRef = $fieldConfig['field'] ?? null;
                            if (is_array($fieldRef)) {
                                $fieldDef = $fieldRef;
                            } elseif (is_string($fieldRef) && str_contains($fieldRef, '.')) {
                                [$fsHandle, $fsFieldHandle] = explode('.', $fieldRef, 2);
                                $fs = \Statamic\Facades\Fieldset::find($fsHandle);
                                $resolved = $fs?->fields()->all()[$fsFieldHandle] ?? null;
                                $fieldDef = $resolved ? array_merge(
                                    ['type' => $resolved->type(), 'display' => $resolved->display()],
                                    $resolved->config()
                                ) : $fieldConfig;
                            } else {
                                $fieldDef = $fieldConfig;
                            }

                            $fieldType = $fieldDef['type'] ?? '';
                            $slim      = ['handle' => $fieldHandle];
                            if ($fieldType)                                    $slim['type']            = $fieldType;
                            if (!empty($fieldDef['display']))                  $slim['display']         = $fieldDef['display'];
                            if (isset($fieldDef['max_files']))                 $slim['max_files']       = (int) $fieldDef['max_files'];
                            if (!empty($fieldDef['required']))                 $slim['required']        = true;
                            if (!empty($fieldDef['character_limit']))          $slim['character_limit'] = $fieldDef['character_limit'];
                            if (in_array($fieldType, $OPTION_TYPES, true) && !empty($fieldDef['options'])) {
                                $slim['options'] = $fieldDef['options'];
                            }
                            // Grid sub-field types so JS normalizer can coerce bard/assets inside rows.
                            if ($fieldType === 'grid' && !empty($fieldDef['fields'])) {
                                $gridSubFields = [];
                                foreach ($fieldDef['fields'] as $gfc) {
                                    $gfHandle = $gfc['handle'] ?? null;
                                    if (!$gfHandle) continue;
                                    $gfRef = $gfc['field'] ?? null;
                                    if (is_array($gfRef)) {
                                        $gfDef = $gfRef;
                                    } elseif (is_string($gfRef) && str_contains($gfRef, '.')) {
                                        [$gFsHandle, $gFsFieldHandle] = explode('.', $gfRef, 2);
                                        $gFs = \Statamic\Facades\Fieldset::find($gFsHandle);
                                        $gResolved = $gFs?->fields()->all()[$gFsFieldHandle] ?? null;
                                        $gfDef = $gResolved ? array_merge(
                                            ['type' => $gResolved->type(), 'display' => $gResolved->display()],
                                            $gResolved->config()
                                        ) : $gfc;
                                    } else {
                                        $gfDef = $gfc;
                                    }
                                    $gfType = $gfDef['type'] ?? '';
                                    $gfSlim = ['handle' => $gfHandle];
                                    if ($gfType) $gfSlim['type'] = $gfType;
                                    $gridSubFields[] = $gfSlim;
                                }
                                if ($gridSubFields) $slim['fields'] = $gridSubFields;
                            }
                            $setFields[] = $slim;

                            // Nested replicator/bard: recurse and attach as sets[fieldHandle]
                            if (in_array($fieldType, $REPLICATOR_TYPES, true) && !empty($fieldDef['sets'])) {
                                $nested = $extractSetsLevel($fieldDef['sets']);
                                if (!empty($nested)) $nestedSets[$fieldHandle] = $nested;
                            }
                        }

                        $entry = [
                            'handle'  => $key,
                            'display' => $config['display'] ?? $key,
                            'fields'  => $setFields,
                        ];
                        if (!empty($nestedSets)) $entry['sets'] = $nestedSets;
                        $level[$key] = $entry;
                    }
                    return $level;
                };

                // Build top-level fields dict and nested sets tree keyed by root field handle.
                $fields = [];
                $tree   = [];
                foreach ($bp->fields()->all() as $handle => $field) {
                    $type    = $field->type();
                    $display = $field->display();
                    $entry   = [];
                    if ($display) $entry['display'] = $display;
                    if ($type)    $entry['type']    = $type;
                    if (in_array($type, $OPTION_TYPES, true)) {
                        $options = $field->config('options');
                        if ($options) $entry['options'] = $options;
                    }
                    $fields[$handle] = $entry;

                    if (in_array($type, $REPLICATOR_TYPES, true)) {
                        $rawSets = $field->config('sets') ?? [];
                        if ($rawSets) {
                            $level = $extractSetsLevel($rawSets);
                            if (!empty($level)) $tree[$handle] = $level;
                        }
                    }
                }

                return response()->json(['fields' => $fields, 'sets' => $tree]);
            });

            Route::get('section-tools/assets/search', function (Request $request) {
                $query = strtolower(trim($request->get('query', '')));

                if ($query === '') {
                    return response()->json([]);
                }

                $root = rtrim(config('filesystems.disks.assets.root', public_path('assets')), '/');

                // Collect all .meta YAML files regardless of folder depth.
                $results = [];
                $iterator = new \RecursiveIteratorIterator(
                    new \RecursiveDirectoryIterator($root, \RecursiveDirectoryIterator::SKIP_DOTS)
                );

                foreach ($iterator as $file) {
                    if ($file->getExtension() !== 'yaml') {
                        continue;
                    }
                    if (basename(dirname($file->getPathname())) !== '.meta') {
                        continue;
                    }

                    $parsed = Yaml::parseFile($file->getPathname());
                    $alt    = $parsed['data']['alt'] ?? '';

                    // Reconstruct the asset path: strip root + .meta/ wrapper + .yaml suffix.
                    $metaDir     = dirname($file->getPathname());          // …/folder/.meta
                    $assetFolder = dirname($metaDir);                      // …/folder
                    $filename    = substr($file->getFilename(), 0, -5);    // strip .yaml
                    $folder      = ltrim(str_replace($root, '', $assetFolder), '/');
                    $assetPath   = $folder . '/' . $filename;

                    $lowerFilename = strtolower($filename);
                    $lowerFolder   = strtolower($folder);
                    $lowerAlt      = strtolower($alt);
                    $lowerPath     = strtolower($assetPath);

                    // Determine the most specific match type.
                    // Queries containing "/" are treated as full/partial path queries.
                    if (str_contains($query, '/')) {
                        if (!str_contains($lowerPath, $query)) continue;
                        $matchedBy = 'path';
                    } elseif (str_contains($lowerPath, $query) && str_contains($lowerFilename, $query)) {
                        $matchedBy = 'filename';
                    } elseif (str_contains($lowerPath, $query) && str_contains($lowerFolder, $query)) {
                        $matchedBy = 'folder';
                    } elseif (str_contains($lowerAlt, $query)) {
                        $matchedBy = 'alt';
                    } else {
                        continue;
                    }

                    $results[] = ['path' => $assetPath, 'alt' => $alt, 'matched_by' => $matchedBy];
                }

                return response()->json($results);
            });
        });
    }
}
