import { useTranslation } from 'react-i18next';

import { openExternalLink } from '@/services/entityMediaService';
import { links } from '@/shared/constants/link';
import { formatReleaseDisplayVersion } from '@/shared/utils/releaseVersion';
import { Button } from '@/ui/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/ui/shadcn/dialog';

const repository = 'https://github.com/E-larex/VRCX-docker';

export function WebAboutDialog({
    open,
    onOpenChange,
    onOpenLicenses
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenLicenses: () => void;
}) {
    const { t } = useTranslation();
    const version = formatReleaseDisplayVersion(VERSION || '') || VERSION;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>VRCX-docker</DialogTitle>
                    <DialogDescription>
                        {t('view.about.web.description')}
                    </DialogDescription>
                </DialogHeader>
                <p className="text-muted-foreground text-xs">
                    {t('view.about.web.version', { version })}
                </p>
                <p className="text-muted-foreground text-sm">
                    {t('view.about.web.attribution')}
                </p>
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="outline"
                        onClick={() => openExternalLink(repository)}
                    >
                        {t('view.about.web.repository')}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => openExternalLink(links.github)}
                    >
                        {t('view.about.web.upstream')}
                    </Button>
                </div>
                <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                            openExternalLink(
                                `${repository}/blob/master/LICENSE`
                            )
                        }
                    >
                        {t('view.about.license_line')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onOpenLicenses}>
                        {t('app_menu.open_source_licenses')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
