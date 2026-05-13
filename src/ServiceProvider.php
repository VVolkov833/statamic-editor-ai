<?php

namespace Local\SectionTools;

use Illuminate\Http\Request;
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
                    $assetPath   = ltrim(str_replace($root, '', $assetFolder), '/') . '/' . $filename;

                    if (str_contains(strtolower($filename), $query) || str_contains(strtolower($alt), $query)) {
                        $results[] = ['path' => $assetPath, 'alt' => $alt];
                    }
                }

                return response()->json($results);
            });
        });
    }
}
