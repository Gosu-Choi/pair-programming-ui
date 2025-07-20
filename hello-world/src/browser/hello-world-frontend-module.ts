import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { HelloWorldContribution } from './hello-world-contribution';

export default new ContainerModule(bind => {
    bind(FrontendApplicationContribution).to(HelloWorldContribution);
});
