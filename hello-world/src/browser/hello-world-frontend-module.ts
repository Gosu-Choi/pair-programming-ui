import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { HelloWorldContribution } from './hello-world-contribution';

export default new ContainerModule(bind => {
    bind(HelloWorldContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).to(HelloWorldContribution);
    bind(CommandContribution).toDynamicValue(ctx =>
        ctx.container.get(HelloWorldContribution)
    ).inSingletonScope();

    bind(MenuContribution).toDynamicValue(ctx =>
        ctx.container.get(HelloWorldContribution)
    ).inSingletonScope();
});
