<?php

namespace Local\SectionTools;

use Statamic\Providers\AddonServiceProvider;

class ServiceProvider extends AddonServiceProvider
{
    public function bootAddon(): void
    {
        // The host app loads the CP script through its Vite pipeline in local development.
    }
}
