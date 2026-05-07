<?php

namespace Local\SectionTools;

use Statamic\Providers\AddonServiceProvider;

class ServiceProvider extends AddonServiceProvider
{
    public function bootAddon(): void
    {
        $this->registerScript(__DIR__.'/../resources/dist/cp.js');
    }
}
